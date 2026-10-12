"use client";

/**
 * The one real Ask PayAI conversation engine — used by both the full
 * /dashboard/ask page and the floating command-bar popup, so "ask a
 * question in the popup" and "ask it on the page" are the exact same
 * pipeline, not two different implementations that can drift apart.
 *
 * Callers own where the state lives (call this once, high enough that it
 * doesn't unmount when a popup closes) and how it's rendered; this hook
 * owns the conversation itself — sending a message, advancing/retrying/
 * cancelling a card, starting over, and (P1.3, persist-mode only) switching
 * between multiple saved conversations.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { executeSendPayment } from "@/lib/ask/sendPayment/orchestrator";
import {
  classifyMessage, executeSwapIntent, executeTradeIntent, executeProtocolActionIntent, respondToUnderstanding,
  type ConversationTurn,
} from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";
import type { AskMessage, Operation } from "@/lib/ask/types";
import type { AutomationSeed, Cadence } from "@/components/dashboard/automationShared";
import {
  clearAllHistory, createConversationId, deleteConversation, deriveConversationTitle,
  loadConversation, loadHistoryIndex, normalizeWalletAddress, renameConversation,
  searchConversations, setActiveConversationPointer, upsertConversation,
  type ConversationSummary,
} from "@/lib/ask/persistChat";
import { useSync } from "@/lib/hooks/useSync";
import { warmPortfolioDiscovery } from "@/lib/hooks/usePortfolio";
import { matchPlanRequest, planFoundText, toPlanText, PLAN_THINKING_LABEL, type PlanRequestKind } from "@/lib/ask/planFastPath";
import { createPlanForTurn } from "@/lib/ask/planTurn";
import { attachTiming, primePlan } from "@/lib/ask/planCards";
import { startAskTiming } from "@/lib/ask/timing";
import { isSafeToRetry } from "@/lib/ask/retryPolicy";
import { applyVisualAddress, type VisualResolution } from "@/lib/ask/visual/resolve";

type VisualResponse = { ok: boolean; resolution?: VisualResolution; message?: string; retryable?: boolean };

/** Details the in-chat AutomationCreator modal returns on a real creation. */
export type CreatedAutomation = { nextRun: number; cadence: Cadence; amount: number; token: string; recipient: string; domain: string | null };

/** Everything one Ask turn needs, fixed when the user sends it — so a retry
 *  replays exactly the same turn. */
interface TurnInput {
  text: string;
  history: ConversationTurn[];
  pending: Understanding | null;
  readyOp: Operation | null;
  startContext: { wallet: string | null; conversationId: string | null };
  planKind: PlanRequestKind | null;
  /** The text sent to the Plan API: the message without its polite framing
   *  ("can you … ?"). Same as `text` when there is none. */
  planText?: string;
  /** ms since epoch, when the user sent it. */
  startedAt: number;
}

/** The normal Ask path's own input bound (lib/agent/brain.ts MAX_INPUT_LENGTH). */
const ASK_INPUT_LIMIT = 500;

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now()}_${idSeq}`;
}

/** Canonical text for a retry — always rebuilt from the operation's own
 *  validated fields, never a stored raw string that might now be stale.
 *  Null unless the failure provably moved nothing (lib/ask/retryPolicy.ts):
 *  a retry starts a NEW payment, so it is never offered when the earlier
 *  transaction may already have reached the chain. */
export function retryTextFor(op: NonNullable<AskMessage["operation"]>): string | null {
  if (!isSafeToRetry(op)) return null;
  if (op.intent.kind === "payment" && op.intent.execution) return op.intent.execution.confirmRawText;
  if (op.intent.kind === "swap" && op.intent.execution) return `Swap ${op.intent.fromAmount} ${op.intent.fromToken} to ${op.intent.toToken}`;
  if (op.intent.kind === "trade_preview") {
    const d = op.intent.data;
    return `${d.action === "buy" ? "Buy" : "Sell"} ${d.spend.amount} ${d.spend.token} for ${d.receive.token}`;
  }
  if (op.intent.kind === "protocol_action") {
    // Rebuild the natural phrase the detector recognizes, so "Try again"
    // re-enters the normal classify → preview funnel rather than replaying a
    // stored request. Phase 2 knows only WMON wrap/unwrap.
    const rawAmount = op.intent.data.inputs.amount;
    const amount = typeof rawAmount === "string" ? rawAmount : "";
    if (op.intent.data.protocol.id === "wmon" && amount) {
      if (op.intent.data.action.id === "wrap") return `Wrap ${amount} MON`;
      if (op.intent.data.action.id === "unwrap") return `Unwrap ${amount} WMON`;
    }
    return null;
  }
  return null;
}

/** Matches ONLY a bare, unambiguous confirmation — "yes", "confirm", "send
 *  it", "swap it", "do it", close variants, and a comma-joined combination
 *  of them ("Yes, send it.") — nothing more. Deliberately not routed
 *  through the AI classifier: whether a message counts as authorization is
 *  a fixed, deterministic decision, not something an LLM's interpretation
 *  could ever loosen or bypass. A message that introduces anything beyond
 *  these exact phrases ("yes, but make it 30") intentionally does NOT
 *  match — see the correction handling in classify.ts instead. */
const AFFIRMATION_WORD = "(?:yes|yeah|yep|yup|confirm(?:ed)?|do it|send it|swap it|go ahead|proceed)";
export const AFFIRMATION_RE = new RegExp(`^${AFFIRMATION_WORD}(?:\\s*,?\\s*${AFFIRMATION_WORD})*[.!]*$`, "i");

/** Operation kinds a bare "yes"/"confirm" is ever allowed to authorize —
 *  the two real, wallet-signed money-moving cards Ask PayAI can show.
 *  Everything else (a schedule/recurring handoff) has no signature step
 *  here to confirm at all — it hands off to the real Automations creator. */
const CONFIRMABLE_KINDS = new Set<Operation["intent"]["kind"]>(["payment", "swap", "trade_preview"]);

/** The most recent still-unsigned, server-approved payment or swap card —
 *  the only thing a bare "yes" is ever allowed to authorize. Undefined when
 *  nothing is actually awaiting confirmation, so "yes" out of nowhere is
 *  never misread as an authorization (see send()'s guard below). */
export function findReadyConfirmableOperation(messages: AskMessage[]): Operation | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const op = messages[i].operation;
    if (op?.status === "ready" && CONFIRMABLE_KINDS.has(op.intent.kind)) return op;
  }
  return undefined;
}

/** How long a swap quote is trusted before a confirm click gets a fresh one
 *  instead of executing the stale price. Matches typical DEX-quote UX
 *  conventions — long enough that a normal "read the preview, then confirm"
 *  pause never trips it, short enough that a price genuinely can't have
 *  drifted far underneath it. */
const QUOTE_STALE_MS = 60_000;

/** Pure so it's directly testable without rendering the hook. */
export function isQuoteStale(quotedAt: number, now: number = Date.now()): boolean {
  return now - quotedAt > QUOTE_STALE_MS;
}

// ── Deterministic post-trade follow-ups (Step 5, Part 7) ────────────────
//
// "How much did I get?", "what's the price now?", "can I sell what I just
// bought?" are all answerable from context PayAI already has, without a
// fresh Anthropic call to interpret them — matching classify.ts's own
// deterministic-first principle (see AFFIRMATION_RE/TOKEN_FOLLOWUP_RE)
// rather than spending a model call on something a regex + the existing
// real data already resolves. A message that doesn't match any of these,
// or matches but has no context to answer from, falls through to the
// normal AI-classified flow untouched. Module-level (not inside the hook)
// so this pure decision logic is directly unit-testable without rendering
// a hook — see test/ask-trade-followups.test.ts.

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export const TRADE_RESULT_RE = /\b(how much (?:did|do) i (?:get|receive|end up with)|what did i (?:get|receive)|how much did (?:that|it) (?:get|make) me)\b/i;
export const SELL_JUST_BOUGHT_RE = /\b(can i sell what i (?:just )?bought|sell what i (?:just )?bought|can i sell (?:that|it)(?: now)?|sell (?:that|it) back)\b/i;
export const PRICE_NOW_RE = /\b(what'?s? the price now|current price|price now|what'?s? it (?:worth|trading at) now)\b/i;

/** The most recent trade that actually settled on-chain (status success +
 *  a real result attached) — never a preview that was only shown, and
 *  never one that errored. */
export function findLastConfirmedTrade(msgs: AskMessage[]): { intent: Extract<Operation["intent"], { kind: "trade_preview" }>; result: NonNullable<Operation["result"]> } | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const op = msgs[i].operation;
    if (op?.intent.kind === "trade_preview" && op.status === "success" && op.result) {
      return { intent: op.intent, result: op.result };
    }
  }
  return null;
}

/** The contract address PayAI would currently understand "it"/"that
 *  token" to mean — an active token_intelligence card, or (failing that)
 *  the most recently confirmed trade's received side, but ONLY when that
 *  side was originally identified BY ADDRESS (an arbitrary token — see
 *  this module's own contract-address-is-identity principle). A curated
 *  symbol trade (e.g. "MON") has no client-known address to look up by,
 *  so it's honestly left unresolved here rather than guessed — the normal
 *  AI-classified flow still gets a chance at it. */
export function findCurrentTokenAddress(msgs: AskMessage[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const op = msgs[i].operation;
    if (op?.intent.kind === "token_intelligence") return op.intent.address;
    if (op?.intent.kind === "trade_preview" && op.status === "success" && op.result) {
      const received = op.intent.execution?.request.outputToken;
      if (received && ADDR_RE.test(received)) return received;
      return null; // a curated-symbol trade -- no address to resolve locally
    }
  }
  return null;
}

/** The address to automatically show a fresh holding for right after a
 *  trade finishes, or null when this isn't that case. Pure and exported
 *  (same convention as isQuoteStale/findCurrentTokenAddress above) so the
 *  decision — WHICH trade outcomes trigger the automatic lookup — is
 *  directly testable without rendering the hook.
 *
 *  Only a completed BUY of an arbitrary, address-identified token
 *  qualifies: a curated-symbol buy (MON/USDC) has no contract address to
 *  look up (and that balance is already visible via "check my balance"), a
 *  SELL just disposed of the token so showing its balance would be
 *  misleading, and anything short of "success" has no real holding to
 *  report yet. */
export function postBuyHoldingAddress(result: Operation): string | null {
  if (result.status !== "success" || result.intent.kind !== "trade_preview" || result.intent.data.action !== "buy") return null;
  const receivedAddress = result.intent.execution?.request.outputToken;
  return receivedAddress && ADDR_RE.test(receivedAddress) ? receivedAddress : null;
}

/** Same shape as classify.ts's own EVM_ADDRESS_RE, duplicated (not imported)
 *  deliberately: classify.ts pulls in the Anthropic SDK and other
 *  server-only weight this client bundle shouldn't carry just for one
 *  regex. Used only to pick a more specific loading label — never to
 *  change what gets sent or how it's classified server-side. */
const CLIENT_EVM_ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

/** P1.5 — the same idea as CLIENT_EVM_ADDRESS_RE above, extended to the
 *  other common request shapes: a plain "…" dots row reads as frozen no
 *  matter what's actually happening underneath it, and a bare "Loading…"
 *  doesn't tell the user PayAI even understood the shape of the request.
 *  Each regex here is a light, best-effort, DISPLAY-ONLY guess — never
 *  imported from classify.ts's own (server-only, Anthropic-importing)
 *  detectors, and never a substitute for the real classification that
 *  follows. Order matters: checked most-specific-first so e.g. "sell my
 *  MON" (a trade signal) doesn't fall through to the payment guess just
 *  because "my" and an asset also appear in a transfer. A message that
 *  matches nothing here keeps the plain animated dots (guessThinkingLabel
 *  returns null) — never a wrong or overconfident label. */
const CLIENT_TRADE_SIGNAL_RE = /\b(buy|purchase|sell|swap|trade)\b/i;
const CLIENT_PAYMENT_SIGNAL_RE = /\b(send|pay)\b/i;
const CLIENT_STATUS_SIGNAL_RE = /\b(go(es)?\s+through|went\s+through|confirmed|is\s+it\s+(done|pending)|status|succeed(ed)?|failed)\b/i;
const CLIENT_WALLET_QUERY_RE = /\b(balance|history|transactions?|activity|automations?|schedule|recurring)\b/i;

export function guessThinkingLabel(text: string): string | null {
  if (CLIENT_EVM_ADDRESS_RE.test(text)) return "Checking the token…";
  if (CLIENT_TRADE_SIGNAL_RE.test(text)) return "Preparing your trade…";
  if (CLIENT_PAYMENT_SIGNAL_RE.test(text)) return "Preparing your payment…";
  if (CLIENT_STATUS_SIGNAL_RE.test(text)) return "Checking Monad…";
  if (CLIENT_WALLET_QUERY_RE.test(text)) return "Checking your wallet…";
  return null;
}

/** What the currently active conversation's own identity is, cached so a
 *  save doesn't need to re-read storage to know its own createdAt/title
 *  state. Null means "no conversation started yet" — see ensureConversation
 *  in useAskChat, the only place this is allocated. */
interface ActiveConversationMeta {
  conversationId: string;
  createdAt: number;
  titleIsCustom: boolean;
  title: string;
}

/**
 * `persist: true` survives a browser refresh — and now a closed tab — via localStorage, and (P1.3)
 * enables multiple named, switchable conversations per wallet — see
 * lib/ask/persistChat.ts. Opt-in, and only ever passed by AskPageChatContext
 * for the full /dashboard/ask page's conversation. CommandBar's own
 * useAskChat() call is a deliberately separate conversation (see
 * AskPageChatContext's doc) and leaves this false, so its popup thread never
 * reads or writes the page's storage, and has no conversation list at all.
 */
export function useAskChat(options?: { persist?: boolean }) {
  const persist = options?.persist ?? false;
  const wallet = useWallet();
  // P1.6: keeps a completed payment/swap/trade in sync with the rest of the
  // dashboard the same way the older console (lib/hooks/useAgentConsole.ts)
  // already does — see lib/hooks/useSync.tsx's own doc ("you never need to
  // refresh after a swap"). Ask PayAI's own execution paths never called
  // this, so a token bought (or a balance changed) through chat could sit
  // invisible on the Overview/Portfolio page well past when it actually
  // settled, until the next automatic 20s heartbeat happened to also clear
  // portfolio-discovery's own cache window — see advanceOperation below.
  const { sync } = useSync();
  // Both start EMPTY on every render path, server included — never read
  // localStorage inside a lazy initializer here. This page is still
  // server-rendered for its first HTML (a plain "use client" page doesn't
  // opt out of that), and the server obviously has no localStorage; seeding
  // the initial client render from it directly produced a real, verified
  // hydration mismatch (React discarding and regenerating the whole tree) the
  // instant a stored conversation existed. Restoring instead happens in an
  // effect below, which only ever runs client-side after hydration — the
  // one render right after mount reconciles to whatever's actually stored.
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // Latency Task 9: a plain "..." dots row reads as frozen on a slower
  // connection. A pasted contract address is the one case cheap and
  // reliable enough to label client-side before the backend has said
  // anything at all — never a guessed VALUE, just which kind of lookup is
  // in flight. Null (the generic dots, unchanged) for everything else.
  const [thinkingLabel, setThinkingLabel] = useState<string | null>(null);
  // When the in-flight turn started, and the step it is still on — the
  // thinking row shows the step after 3 s and a Retry at 5 s.
  const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null);
  const [thinkingHint, setThinkingHint] = useState<string | null>(null);
  // The in-flight turn: its id (a retried or superseded attempt never lands),
  // its abort, and how to run it again.
  const turnSeq = useRef(0);
  // Visual intent input: the address last shown from an image/QR, so a reply
  // like "send 5 USDC to this address" means that address. Cleared once used.
  const visualAddressRef = useRef<string | null>(null);
  const visualBusyRef = useRef(false);
  const activeTurn = useRef<{ id: number; abort: AbortController; retry: () => void } | null>(null);
  // The wallet whose Plan API create came back 401 this session: its sends
  // skip the plan fast path rather than pay for a refused round trip.
  const planPathOffFor = useRef<string | null>(null);
  // The in-flight, not-yet-complete (or just-completed) intent — carried
  // into the next turn so "20", "MON", or "actually make it 30" is
  // understood as continuing/correcting THIS request rather than starting
  // an unrelated new one. See lib/ask/intent/classify.ts.
  const [pending, setPending] = useState<Understanding | null>(null);
  // Live text for whatever's happening RIGHT NOW during "confirming" --
  // "waiting for your signature" reads as a lie the instant it's still
  // showing after the user already signed and the tx is on-chain pending.
  // Keyed by operation id so switching cards (or a stale one) never bleeds
  // progress text onto the wrong card; cleared once that operation settles.
  const [progress, setProgress] = useState<Record<string, string>>({});
  // P1.3: the wallet's own conversation list, for the ConversationList rail.
  // Lightweight summaries only (see persistChat's own doc on why) — kept in
  // sync after every mutation (send, rename, delete, clear, switch, wallet
  // change) via refreshConversations() below.
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);

  // Whether the restore/reconcile effect below has completed at least once
  // since mount. Starts false so the SAVE effect (declared first — effect
  // order within a commit follows declaration order) always no-ops on the
  // very first commit, before the RESTORE effect (declared second) has had
  // a chance to populate messages/pending from storage. Without this, the
  // save effect would see the still-empty initial state on that first pass
  // and write/clear an empty record, racing the restore that's about to
  // replace it. Stays true after that — the restore effect re-runs on every
  // wallet change too (see below), but by then this guard has already done
  // its one job of protecting the very first commit.
  const restoredRef = useRef(false);

  // P1.2: which wallet identity the in-memory messages/pending currently
  // belong to — normalized the same way persistChat.ts does, so `null` means
  // either "no wallet connected" or "not yet reconciled". Saves always write
  // under THIS, never under whatever `wallet.address` happens to read as at
  // save time, which matters the instant a wallet change is in flight (see
  // the reconcile effect below): by the time it changes, that effect has
  // already updated it synchronously, so a save that fires afterward can
  // never attribute one wallet's data to another's key.
  const currentWalletRef = useRef<string | null>(null);
  // P1.3: which of that wallet's conversations is currently active, plus
  // its own cached metadata (createdAt/title/whether the title was manually
  // set) so a save can upsert without re-reading storage first. Null means
  // "no conversation started yet in this wallet bucket" — see
  // ensureConversation, the only place a fresh one gets allocated.
  const activeConversationIdRef = useRef<string | null>(null);
  const activeConversationMetaRef = useRef<ActiveConversationMeta | null>(null);

  /** Captures {wallet, conversation} at the top of an async function, before
   *  any await. */
  function captureContext(): { wallet: string | null; conversationId: string | null } {
    return { wallet: currentWalletRef.current, conversationId: activeConversationIdRef.current };
  }
  /** True when EITHER the connected wallet OR the active conversation has
   *  changed since `start` was captured — i.e. this function's result is
   *  about to land after the user already switched away from the wallet
   *  and/or conversation it started under. Every function below that
   *  appends a brand-new message or replaces `pending` after an `await`
   *  checks this first and bails out silently if stale, so a slow response
   *  begun under one wallet/conversation can never surface in a DIFFERENT
   *  one's visible conversation. (An update that instead modifies an
   *  EXISTING message by operation id — e.g. advanceOperation's setOp, or
   *  completeAutomationDraft — doesn't need this guard: operation ids are
   *  globally unique, so that kind of update is already a no-op once the
   *  message array has been swapped out from under it.) Always false when
   *  persistence is off (CommandBar's popup): both refs never leave null
   *  there, so this can never trip — unchanged from today's behavior for
   *  that surface. */
  function isStaleContext(start: { wallet: string | null; conversationId: string | null }): boolean {
    return currentWalletRef.current !== start.wallet || activeConversationIdRef.current !== start.conversationId;
  }

  /** Refreshes the rail's list from storage — called after every mutation
   *  so the UI never shows a stale summary (wrong title, wrong timestamp, a
   *  since-deleted or since-pruned conversation still listed). */
  function refreshConversations() {
    const w = currentWalletRef.current;
    setConversations(w ? loadHistoryIndex(w).summaries : []);
  }

  /** Allocates a real conversationId (and its metadata) the FIRST time a
   *  brand-new conversation actually gets a message — never for an unused,
   *  still-empty "New conversation" state, so the history list never fills
   *  up with empty entries nobody ever used. Idempotent: once allocated for
   *  this conversation, later calls just return the same id. Must run
   *  synchronously, before any await, in every path that can append the
   *  first message of a conversation — see send()'s very first line. */
  function ensureConversation(): string {
    if (!activeConversationMetaRef.current) {
      const id = createConversationId();
      activeConversationIdRef.current = id;
      activeConversationMetaRef.current = { conversationId: id, createdAt: Date.now(), titleIsCustom: false, title: "New conversation" };
    }
    return activeConversationIdRef.current!;
  }

  // Mirrors messages/pending into localStorage after every change, under
  // whichever conversation is currently active (see persistChat.ts's
  // upsertConversation) — nothing else here needs to survive a refresh:
  // `progress` is only ever meaningful while a request this same page load
  // made is still in flight, and `automationDraft` is just whether the modal
  // is open, fully reconstructible from the operation's own handoff prefill
  // (see advanceOperation below) — so a refresh naturally leaves the modal
  // closed rather than reopening it unprompted, without losing any real data.
  useEffect(() => {
    if (!persist || !restoredRef.current) return;
    const w = currentWalletRef.current;
    const meta = activeConversationMetaRef.current;
    if (!w || !meta) return; // no wallet, or no conversation started yet — nothing to save
    const title = meta.titleIsCustom ? meta.title : deriveConversationTitle(messages);
    meta.title = title; // keep the cached title in sync for the next save
    const summaries = upsertConversation(w, {
      conversationId: meta.conversationId, title, titleIsCustom: meta.titleIsCustom,
      createdAt: meta.createdAt, updatedAt: Date.now(), messages, pending,
    });
    setConversations(summaries);
  }, [persist, messages, pending]);

  // Restores the CONNECTED WALLET's own active conversation (and its
  // conversation list) — on mount, and again every time the connected
  // wallet identity changes (connecting for the first time, disconnecting,
  // or switching to a different wallet; see lib/wallet/useWallet.tsx's
  // accountsChanged handling for how wallet.address itself updates live).
  // Client-only, so the server-rendered (always-empty) first paint is never
  // contradicted (see the state declarations' own doc above).
  //
  // P1.2/P1.3's actual safety property lives here: every distinct value of
  // wallet.address — including null, "no wallet" — is its own identity
  // bucket. Switching buckets always reloads from scratch for the NEW
  // identity (that wallet's own conversation list + active conversation, or
  // a clean slate if it has none) and never carries the OLD bucket's
  // messages/pending/conversation list along. The OLD bucket's own data
  // isn't lost if it was a real wallet: the save effect above already wrote
  // every change to ITS OWN keys throughout, so it's sitting in storage
  // exactly where switching back to it will find it.
  //
  // Never restores mid-execution state as executable: loadConversation
  // itself downgrades any "confirming" card to a safe error before this
  // ever sees it (see lib/ask/persistChat.ts's sanitizeOperation) — nothing
  // here can revive a signature or a broadcast, only redisplay already-safe
  // history/context, and only for the wallet that actually produced it.
  //
  // useLayoutEffect, not useEffect: wallet.address can change (a real
  // wallet-switch event) in the same commit that still holds the OLD
  // wallet's messages in local state — a plain useEffect runs AFTER the
  // browser paints, which would let that stale pairing (old messages, new
  // address already showing) actually flash on screen for a frame before
  // this clears it. A layout effect flushes its setState calls synchronously
  // before paint, so the browser only ever paints the reconciled result —
  // this is precisely the narrow, correctness-motivated case that
  // justifies useLayoutEffect over the usual useEffect default. Still never
  // runs during SSR (same as useEffect), so the hydration-safety above is
  // unaffected.
  useLayoutEffect(() => {
    currentWalletRef.current = normalizeWalletAddress(persist ? wallet.address : null);
    activeConversationIdRef.current = null;
    activeConversationMetaRef.current = null;
    if (!persist) { restoredRef.current = true; return; }
    const w = currentWalletRef.current;
    if (!w) {
      setMessages([]);
      setPending(null);
      setConversations([]);
      restoredRef.current = true;
      return;
    }
    const index = loadHistoryIndex(w);
    setConversations(index.summaries);
    const active = index.activeConversationId ? loadConversation(w, index.activeConversationId) : null;
    if (active) {
      activeConversationIdRef.current = active.conversationId;
      activeConversationMetaRef.current = { conversationId: active.conversationId, createdAt: active.createdAt, titleIsCustom: active.titleIsCustom, title: active.title };
      setMessages(active.messages);
      setPending(active.pending);
    } else {
      setMessages([]);
      setPending(null);
    }
    restoredRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, wallet.address]);

  // The in-chat automation modal. A scheduled/recurring handoff card no longer
  // navigates the user away to /dashboard/automations — it opens the SAME
  // AutomationCreator wizard as a modal over the conversation, seeded with the
  // already-resolved prefill. `operationId` remembers which card to turn into
  // a success state once creation actually completes. Null = closed.
  const [automationDraft, setAutomationDraft] = useState<{ operationId: string; seed: AutomationSeed } | null>(null);

  /** Close the modal without creating — the handoff card stays "ready", so the
   *  user can reopen it. Nothing was signed or moved. */
  function closeAutomationDraft() {
    setAutomationDraft(null);
  }

  /** The AutomationCreator created a real automation. Turn the originating
   *  handoff card into a success state built from the REAL fields the creation
   *  returned (nextRun comes from the saved record), then close the modal. */
  function completeAutomationDraft(created: CreatedAutomation) {
    setAutomationDraft((draft) => {
      if (draft) {
        setMessages((prev) => prev.map((m) =>
          m.operation?.id === draft.operationId
            ? { ...m, operation: { ...m.operation, status: "success", automation: created } }
            : m));
      }
      return null;
    });
  }

  /** Re-quotes a swap whose preview has gone stale — built entirely from the
   *  expired card's own already-known pair/amount, so this never needs a
   *  fresh Anthropic call just to ask for the exact same thing again. */
  async function requoteExpiredSwap(intent: Extract<Operation["intent"], { kind: "swap" }>) {
    const startContext = captureContext();
    const notice: AskMessage = { id: nextId("msg"), role: "assistant", content: "That quote has expired. I'll get you a fresh quote.", createdAt: Date.now() };
    setMessages((m) => [...m, notice]);
    const understanding: Understanding = { kind: "swap", outcome: "complete", slots: { amount: intent.fromAmount, fromAsset: intent.fromToken, toAsset: intent.toToken } };
    const { message } = await respondToUnderstanding(understanding, wallet.address);
    if (isStaleContext(startContext)) return;
    setMessages((m) => [...m, message]);
  }

  /** Re-quotes a trade whose preview has gone stale — built entirely from
   *  the expired card's own already-known action/pair/amount, so this never
   *  needs a fresh Anthropic call just to ask for the exact same thing
   *  again. Mirrors requoteExpiredSwap above. */
  async function requoteExpiredTrade(intent: Extract<Operation["intent"], { kind: "trade_preview" }>) {
    const startContext = captureContext();
    const notice: AskMessage = { id: nextId("msg"), role: "assistant", content: "That quote has expired. I'll get you a fresh quote.", createdAt: Date.now() };
    setMessages((m) => [...m, notice]);
    const req = intent.execution?.request;
    const understanding: Understanding = req
      ? { kind: "trade", outcome: "complete", slots: { tradeAction: req.action, fromAsset: req.inputToken, toAsset: req.outputToken, amount: req.amount, amountType: req.amountType, slippage: req.slippage } }
      : { kind: "trade", outcome: "complete", slots: { tradeAction: intent.data.action, fromAsset: intent.data.spend.token, toAsset: intent.data.receive.token, amount: intent.data.spend.amount, amountType: "exact_input", slippage: null } };
    const { message } = await respondToUnderstanding(understanding, wallet.address);
    if (isStaleContext(startContext)) return;
    setMessages((m) => [...m, message]);
  }

  function assistantText(content: string): AskMessage {
    return { id: nextId("msg"), role: "assistant", content, createdAt: Date.now() };
  }

  /** "How much did I get?" — answered directly from the confirmed trade's
   *  own real spend/receive amounts. No fetch, no Anthropic: the numbers are
   *  already sitting in the card that's on screen. */
  async function answerTradeResult(userMsg: AskMessage) {
    setMessages((m) => [...m, userMsg]);
    setInput("");
    const found = findLastConfirmedTrade(messages);
    const reply = found
      ? assistantText(`You spent ${found.intent.data.spend.amount} ${found.intent.data.spend.token} and received ${found.intent.data.receive.amount} ${found.intent.data.receive.token}, via ${found.intent.data.route.provider}. Transaction: ${found.result.txHash}`)
      : assistantText("I don't have a recently completed trade to answer that from — what would you like to check?");
    setMessages((m) => [...m, reply]);
  }

  /** "Can I sell what I just bought?" — deterministically reverses the last
   *  confirmed trade's own pair (received side becomes the new input, spent
   *  side becomes the new output) through the SAME real dispatchTrade path
   *  a typed "sell X for Y" already uses — a genuine new quote, never a
   *  cached or guessed one. */
  async function sellLastPurchase(userMsg: AskMessage) {
    const startContext = captureContext();
    setMessages((m) => [...m, userMsg]);
    setInput("");
    const found = findLastConfirmedTrade(messages);
    const req = found?.intent.execution?.request;
    if (!found || !req) {
      const reply = assistantText("I don't have a recently completed trade to sell from — tell me the token and amount you'd like to sell.");
      setMessages((m) => [...m, reply]);
      return;
    }
    const understanding: Understanding = {
      kind: "trade", outcome: "complete",
      slots: { tradeAction: "sell", fromAsset: req.outputToken, toAsset: req.inputToken, amount: found.intent.data.receive.amount, amountType: "exact_input", slippage: req.slippage },
    };
    const { message } = await respondToUnderstanding(understanding, wallet.address);
    if (isStaleContext(startContext)) return;
    setMessages((m) => [...m, message]);
  }

  /** "What's the price now?" — a genuinely fresh market-data lookup (never
   *  the trade's own now-stale quote) for whichever token is currently in
   *  context, via the exact same real token_lookup path a pasted contract
   *  address already uses. */
  async function answerPriceNow(userMsg: AskMessage) {
    const startContext = captureContext();
    setMessages((m) => [...m, userMsg]);
    setInput("");
    const address = findCurrentTokenAddress(messages);
    if (!address) {
      const understanding = await classifyMessage(userMsg.content, [...messages, userMsg].slice(-8).map((m) => ({ role: m.role, content: m.content })), pending);
      const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);
      if (isStaleContext(startContext)) return;
      setPending(nextPending);
      setMessages((m) => [...m, message]);
      return;
    }
    const understanding: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: address } };
    const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);
    if (isStaleContext(startContext)) return;
    setPending(nextPending);
    setMessages((m) => [...m, message]);
  }

  /** After a completed BUY of an arbitrary, address-identified token,
   *  automatically shows what the wallet now holds of it — real balance and
   *  real value in $ and MON — without the user having to ask or re-paste
   *  the contract address. Reuses the EXACT same token-intelligence lookup a
   *  pasted CA already dispatches through (a real /api/ask/token read, never
   *  a fresh Anthropic call — token_lookup is always deterministically
   *  routed, see classify.ts's own detectTokenLookup) and only ever reads;
   *  it never signs or executes anything, so this is purely a response-layer
   *  addition, not a second execution path. */
  async function showPostBuyHolding(result: Operation, startContext: { wallet: string | null; conversationId: string | null }) {
    const receivedAddress = postBuyHoldingAddress(result);
    if (!receivedAddress) return;
    const understanding: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: receivedAddress } };
    const { message } = await respondToUnderstanding(understanding, wallet.address);
    if (isStaleContext(startContext)) return;
    setMessages((m) => [...m, message]);
  }

  /** Brings the rest of the dashboard (balances, portfolio, history,
   *  notifications) in sync with a just-settled payment/swap/trade — the
   *  same promise lib/hooks/useSync.tsx already makes for the older console
   *  (lib/hooks/useAgentConsole.ts's own `void sync()` after settlement),
   *  which Ask PayAI's own execution paths never called until now. Without
   *  it, a token bought (or any balance changed) through chat could sit
   *  stale on the Overview/Portfolio page well past when it actually
   *  settled, waiting on the next automatic 20s heartbeat.
   *
   *  `warmDiscovery` additionally forces one fresh portfolio-discovery scan
   *  for this wallet FIRST, bypassing its own 5-minute cache (see
   *  warmPortfolioDiscovery's own doc) — only a swap/trade can introduce a
   *  token this wallet has never held before, so a plain payment (always an
   *  already-known MON/USDC) skips this extra call. Doing it before `sync()`
   *  matters: sync() only re-triggers each mounted usePortfolio's own
   *  refetch, which is only useful once the shared cache it will hit is
   *  actually fresh.
   *
   *  Only ever fires on a confirmed "success" — never for "submitted"
   *  (nothing has actually settled yet) or "error". Fire-and-forget: never
   *  blocks or changes the operation card's own result either way. */
  async function syncDashboardAfter(result: Operation, warmDiscovery: boolean) {
    if (result.status !== "success") return;
    if (warmDiscovery && wallet.address) await warmPortfolioDiscovery(wallet.address);
    void sync();
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    // Allocates this conversation's identity on its very first message —
    // synchronously, before anything else (including the staleness guards
    // below) can capture a stale/ambiguous "no conversation yet" (null)
    // context. See ensureConversation's own doc. A no-op once a conversation
    // is already active.
    ensureConversation();
    setThinkingLabel(null); // cleared up front so a stale label from a previous turn never leaks into this one

    // Natural-language confirmation of an already-previewed payment or swap.
    // Checked BEFORE anything is sent to the AI: whether this message
    // authorizes a real operation is decided here, deterministically,
    // against a card this module already built and the server already
    // approved — never by asking the model to decide it. No matching card
    // means "yes" is just a stray word, never an authorization (see
    // AFFIRMATION_RE's doc).
    const readyOp = findReadyConfirmableOperation(messages);
    if (readyOp && AFFIRMATION_RE.test(trimmed)) {
      const userMsg: AskMessage = { id: nextId("u"), role: "user", content: trimmed, createdAt: Date.now() };
      setMessages((m) => [...m, userMsg]);
      setInput("");
      await advanceOperation(readyOp.id);
      return;
    }

    // Deterministic post-trade follow-ups (see the block above) — checked
    // before the AI classifier for the same reason AFFIRMATION_RE is: these
    // are fixed, regex-matched shortcuts over data PayAI already has, not
    // something worth spending a model call to interpret.
    if (TRADE_RESULT_RE.test(trimmed)) {
      const userMsg: AskMessage = { id: nextId("u"), role: "user", content: trimmed, createdAt: Date.now() };
      setThinking(true);
      try { await answerTradeResult(userMsg); } finally { setThinking(false); }
      return;
    }
    if (SELL_JUST_BOUGHT_RE.test(trimmed)) {
      const userMsg: AskMessage = { id: nextId("u"), role: "user", content: trimmed, createdAt: Date.now() };
      setThinking(true);
      try { await sellLastPurchase(userMsg); } finally { setThinking(false); }
      return;
    }
    if (PRICE_NOW_RE.test(trimmed)) {
      const userMsg: AskMessage = { id: nextId("u"), role: "user", content: trimmed, createdAt: Date.now() };
      setThinking(true);
      try { await answerPriceNow(userMsg); } finally { setThinking(false); }
      return;
    }

    const startContext = captureContext();
    let requestText = trimmed;
    if (visualAddressRef.current) {
      const withAddress = applyVisualAddress(trimmed, visualAddressRef.current);
      visualAddressRef.current = null;
      if (withAddress) requestText = withAddress;
    }
    const userMsg: AskMessage = { id: nextId("u"), role: "user", content: trimmed, createdAt: Date.now() };
    // Optimistic: the user's message is on screen before anything is sent.
    setMessages((m) => [...m, userMsg]);
    setInput("");
    const history: ConversationTurn[] = [...messages, userMsg]
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));
    // Plan fast path: an exactly-phrased transfer / swap goes straight to the
    // Plan API's deterministic intake — no model call, one round trip. Only
    // with a wallet (plans belong to one), and not after this wallet's grant
    // was refused this session (the normal path serves it instead).
    // Longer than the normal path accepts: only a plan can serve it, so the
    // Plan API is asked (and explains a refusal) even without a hint.
    if (requestText !== trimmed) history[history.length - 1] = { role: "user", content: requestText };
    await runRequest(requestText, history, startContext, readyOp ?? null);
  }

  /** The normal Ask turn for one request sentence — shared by typed text and
   *  by a sentence composed from an image (sendVisual), so both reach exactly
   *  the same plan grammar, validation, review card and wallet approval. */
  async function runRequest(text: string, history: ConversationTurn[], startContext: ReturnType<typeof captureContext>, readyOp: Operation | null) {
    const planText = toPlanText(text);
    const planKind = wallet.address && planPathOffFor.current !== wallet.address.toLowerCase()
      ? matchPlanRequest(planText) ?? (text.length > ASK_INPUT_LIMIT ? "multi" : null)
      : null;
    await runTurn({ text, history, pending, readyOp, startContext, planKind, planText, startedAt: Date.now() }, false);
  }

  /**
   * Visual intent input: an image (or QR code) plus an optional caption.
   * The server only READS it (POST /api/ask/visual) and answers with either
   * a plain request sentence or a question. A sentence goes through
   * runRequest — the same path as typed text — so the image is never an
   * approval and nothing runs until the user reviews the plan and their
   * wallet signs. The image itself is not kept in the conversation.
   */
  async function sendVisual(image: Blob, caption: string): Promise<boolean> {
    if (thinking || visualBusyRef.current) return false;
    visualBusyRef.current = true;
    ensureConversation();
    const startContext = captureContext();
    const cap = caption.trim();
    const userMsg: AskMessage = { id: nextId("u"), role: "user", content: cap ? `[Image] ${cap}` : "[Image]", createdAt: Date.now() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    const say = (content: string) => setMessages((m) => [...m, { id: nextId("a"), role: "assistant", content, createdAt: Date.now() }]);
    setThinkingStartedAt(Date.now());
    setThinkingLabel("Reading your image");
    setThinkingHint("Still reading the image");
    setThinking(true);
    let res: VisualResponse | null = null;
    try {
      const form = new FormData();
      form.append("image", image, "upload");
      if (cap) form.append("caption", cap);
      const r = await fetch("/api/ask/visual", { method: "POST", body: form, credentials: "same-origin" });
      res = (await r.json().catch(() => null)) as VisualResponse | null;
      if (!res) res = { ok: false, message: "PayAI couldn't read that image just now. Try again in a moment.", retryable: true };
    } catch {
      res = { ok: false, message: "Couldn't reach PayAI just now — check your connection and try again.", retryable: true };
    } finally {
      setThinking(false);
      visualBusyRef.current = false;
    }
    if (isStaleContext(startContext)) return true;
    if (!res.ok || !res.resolution) {
      say(`${res.message ?? "PayAI couldn't read that image."} Nothing was prepared.`);
      return true;
    }
    const v = res.resolution;
    visualAddressRef.current = v.kind === "clarify" && v.address ? v.address : null;
    if (v.kind !== "intent") { say(v.reply); return true; }
    say(`${v.found.length ? `Here's what I read:\n${v.found.map((f) => `• ${f}`).join("\n")}\n\n` : ""}Preparing this for your review: “${v.text}”. Check every detail before you approve — if anything is wrong, cancel and type the correct request.`);
    const history: ConversationTurn[] = [...messages, userMsg].slice(-7)
      .map((m) => ({ role: m.role, content: m.content }))
      .concat({ role: "user", content: v.text });
    await runRequest(v.text, history, startContext, null);
    return true;
  }

  /** One Ask turn after the user's message is on screen: the plan fast path
   *  when it applies, else (or when the Plan API can't serve it) the normal
   *  understand → respond path. Re-entered by retryThinking with retry=true
   *  — the user message is never added twice, and a retried plan turn never
   *  leaves two plans (see lib/ask/planTurn.ts). */
  async function runTurn(t: TurnInput, retry: boolean) {
    const id = ++turnSeq.current;
    const ac = new AbortController();
    activeTurn.current?.abort.abort();
    activeTurn.current = { id, abort: ac, retry: () => void runTurn(t, true) };
    const current = () => activeTurn.current?.id === id && !isStaleContext(t.startContext);
    setThinkingStartedAt(Date.now());
    setThinking(true);
    try {
      if (t.planKind) {
        setThinkingLabel(PLAN_THINKING_LABEL[t.planKind]);
        setThinkingHint(t.planKind === "transfer" ? "Still checking the recipient and amount" : t.planKind === "multi" ? "Still checking each action" : "Still checking the tokens and amount");
        const timing = startAskTiming("plan");
        timing.mark("intent_detected");
        const r = await createPlanForTurn(t.planText ?? t.text, { signal: ac.signal, since: t.startedAt, retry });
        if (!current()) return;
        if (r.data) {
          timing.mark("plan_created");
          primePlan(r.data);
          attachTiming(r.data.plan.planId, timing);
          setPending(null);
          setMessages((m) => [...m, {
            id: nextId("a"), role: "assistant", content: planFoundText(t.planKind!, r.data!.review.steps.length), createdAt: Date.now(),
            plan: { planId: r.data!.plan.planId, kind: t.planKind! },
          }]);
          return;
        }
        if (r.status === 401 && wallet.address) planPathOffFor.current = wallet.address.toLowerCase();
        timing.mark("fallback");
        // A request longer than the normal path accepts (MAX_INPUT_LENGTH)
        // can only be a plan: say exactly why the plan was refused instead of
        // handing it to a path that would reject its length. Nothing planned.
        // The same for several actions in one request: only a plan can hold
        // them, and the single-intent path would keep one and drop the rest.
        if (t.text.length > ASK_INPUT_LIMIT || t.planKind === "multi" || t.planKind === "swap_send") {
          setPending(null);
          setMessages((m) => [...m, {
            id: nextId("a"), role: "assistant", createdAt: Date.now(),
            content: r.refusal
              ? `Nothing was planned. ${r.refusal.message}`
              : r.status === 401
                ? "Nothing was planned. Unlock your wallet so PayAI can prepare a plan for this request."
                : "Nothing was planned — PayAI couldn't prepare that request just now. Try again in a moment.",
          }]);
          return;
        }
        // The Plan API has answered for this request; a retry from here on
        // repeats only the understanding step.
        if (activeTurn.current?.id === id) activeTurn.current.retry = () => void runTurn({ ...t, planKind: null }, true);
      }

      setThinkingLabel(guessThinkingLabel(t.text) ?? "Reading your request");
      setThinkingHint("Still checking the request");
      const timing = startAskTiming("understand");
      const understanding = await classifyMessage(t.text, t.history, t.pending, ac.signal);
      if (!current()) return;
      timing.mark("intent_detected");
      if (understanding.outcome === "complete") {
        setThinkingLabel("Preparing the preview");
        setThinkingHint("Still checking the details with the network");
      }
      const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);
      // The wallet or active conversation may have changed while this was
      // in flight — never let a response resolved for the OLD context land
      // in whatever's now showing for a different one. See isStaleContext's
      // own doc. A retried turn also drops the attempt it replaced.
      if (!current()) return;
      if (message.operation?.status === "ready") timing.mark("quote_ready");

      // A freshly-built ready card (e.g. from "actually make it 75", or a
      // corrected swap amount/token) supersedes any earlier one still
      // awaiting confirmation — the old card's unsigned transaction reflects
      // details the user just changed, so it must never stay clickable once
      // a corrected preview exists.
      const readyOp = t.readyOp;
      if (
        readyOp && readyOp.id !== message.operation?.id &&
        message.operation?.status === "ready" && CONFIRMABLE_KINDS.has(message.operation.intent.kind)
      ) {
        setMessages((prev) =>
          prev.map((m) =>
            m.operation?.id === readyOp.id
              ? { ...m, operation: { ...m.operation, status: "error", error: { message: `Replaced by the updated ${message.operation!.intent.kind === "swap" ? "swap" : "payment"} below.`, code: "SUPERSEDED" } } }
              : m,
          ),
        );
      }

      setPending(nextPending);
      setMessages((m) => [...m, message]);
      requestAnimationFrame(() => timing.mark("response_rendered"));
    } finally {
      if (activeTurn.current?.id === id) {
        activeTurn.current = null;
        setThinking(false);
        setThinkingStartedAt(null);
        setThinkingHint(null);
      }
    }
  }

  /** The stalled-turn Retry: abandons the in-flight attempt and runs the
   *  same turn again (see runTurn). A no-op when nothing is in flight. */
  function retryThinking() {
    activeTurn.current?.retry();
  }

  /** Edit on a plan card: the request goes back in the composer. */
  function editRequest(text: string) {
    setInput(text);
  }

  /** Advances a card exactly one step per click, dispatching by what kind of
   *  real operation it is. Every branch below is gated on status === "ready"
   *  — a card this module already built and the server already approved —
   *  so nothing here can advance a card that hasn't been through validation. */
  async function advanceOperation(operationId: string) {
    const op = messages.find((m) => m.operation?.id === operationId)?.operation;
    if (!op || op.status !== "ready") return;

    const setOp = (next: typeof op) =>
      setMessages((prev) => prev.map((m) => (m.operation?.id === operationId ? { ...m, operation: next } : m)));
    const setProgressFor = (label: string) => setProgress((p) => ({ ...p, [operationId]: label }));
    const clearProgressFor = () =>
      setProgress((p) => {
        if (!(operationId in p)) return p;
        const next = { ...p };
        delete next[operationId];
        return next;
      });

    if (op.intent.kind === "payment" && op.intent.execution) {
      setOp({ ...op, status: "confirming" });
      const result = await executeSendPayment(op, wallet, setProgressFor);
      clearProgressFor();
      setOp(result);
      await syncDashboardAfter(result, false);
      return;
    }
    if (op.intent.kind === "swap" && op.intent.execution) {
      if (!wallet.address) {
        setOp({ ...op, status: "error", error: { message: "Your wallet disconnected — reconnect and try again.", code: "NO_WALLET" } });
        return;
      }
      // A quote's price is only as good as how recently it was fetched —
      // confirming long after it was shown could sign into a materially
      // different price than what was previewed. Never execute a stale
      // quote; get a fresh one instead (no Anthropic call needed — the
      // pair/amount are already known from the stale card itself).
      if (isQuoteStale(op.intent.execution.quotedAt)) {
        setOp({ ...op, status: "error", error: { message: "That quote has expired.", code: "QUOTE_EXPIRED" } });
        await requoteExpiredSwap(op.intent);
        return;
      }
      setOp({ ...op, status: "confirming" });
      const result = await executeSwapIntent(op, wallet, wallet.address, setProgressFor);
      clearProgressFor();
      setOp(result);
      await syncDashboardAfter(result, true);
      return;
    }
    if (op.intent.kind === "trade_preview" && op.intent.execution) {
      if (!wallet.address) {
        setOp({ ...op, status: "error", error: { message: "Your wallet disconnected — reconnect and try again.", code: "NO_WALLET" } });
        return;
      }
      // Same reasoning as swap above: never execute a stale quote — get a
      // fresh one instead (no Anthropic call needed, the trade's own
      // already-known fields are enough).
      if (isQuoteStale(op.intent.data.quotedAt)) {
        setOp({ ...op, status: "error", error: { message: "That quote has expired.", code: "QUOTE_EXPIRED" } });
        await requoteExpiredTrade(op.intent);
        return;
      }
      const startContext = captureContext();
      setOp({ ...op, status: "confirming" });
      const result = await executeTradeIntent(op, wallet, wallet.address, setProgressFor);
      clearProgressFor();
      setOp(result);
      await syncDashboardAfter(result, true);
      await showPostBuyHolding(result, startContext);
      return;
    }
    if (op.intent.kind === "protocol_action" && op.intent.execution) {
      if (!wallet.address) {
        setOp({ ...op, status: "error", error: { message: "Your wallet disconnected — reconnect and try again.", code: "NO_WALLET" } });
        return;
      }
      // Same staleness discipline as trade/swap: never execute against a
      // quote old enough to have moved — the build endpoint re-checks
      // freshness server-side too, but failing fast here avoids a needless
      // round-trip and a confusing server-side QUOTE_STALE.
      if (isQuoteStale(op.intent.data.quotedAt)) {
        setOp({ ...op, status: "error", error: { message: "That quote has expired — ask again to get a fresh one.", code: "QUOTE_EXPIRED" } });
        return;
      }
      setOp({ ...op, status: "confirming" });
      const result = await executeProtocolActionIntent(op, wallet, wallet.address);
      setOp(result);
      // A wrap/unwrap changes the wallet's WMON/MON balance — refresh the
      // dashboard the same way a completed trade does. Never warms discovery
      // (no new arbitrary token was acquired), so `false`.
      await syncDashboardAfter(result, false);
      return;
    }
    if ((op.intent.kind === "scheduled_payment" || op.intent.kind === "recurring_payment") && op.intent.handoff) {
      // Open the AutomationCreator modal IN-CHAT (seeded with the resolved
      // prefill) rather than navigating away to /dashboard/automations. The
      // card stays "ready" while the modal is open, so closing it without
      // creating leaves the card actionable again. Creation still happens
      // entirely inside the same wizard — same wallet signature, same
      // approval/reserve, same signed POST — via completeAutomationDraft.
      // handoffToAutomations remains as the navigation fallback (and is still
      // exercised directly by tests) for any surface that can't mount the modal.
      const p = op.intent.handoff.prefill;
      const seed: AutomationSeed = {
        amount: p.amount, token: p.token, recipient: p.recipient, domain: p.domain ?? null,
        cadence: p.cadence as Cadence, nextRun: p.nextRun ?? undefined,
      };
      setAutomationDraft({ operationId: op.id, seed });
      return;
    }
  }

  /** Re-runs the original request from scratch through the real pipeline —
   *  never resubmits a stale signed/quoted artifact. A fresh request
   *  re-validates against current balances/quotes/state instead of blindly
   *  retrying whatever failed. */
  function retryOperation(operationId: string) {
    const op = messages.find((m) => m.operation?.id === operationId)?.operation;
    const text = op ? retryTextFor(op) : null;
    if (text) void send(text);
  }

  /** Cancelling a ready card ends it rather than reviving it — every real
   *  card here is already server-approved by the time it's shown (no
   *  "preview" step to fall back to), and no signature was ever requested,
   *  so there's nothing to undo but the card itself. */
  function cancelOperation(operationId: string) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.operation?.id !== operationId) return m;
        return { ...m, operation: { ...m.operation, status: "error", error: { message: "Cancelled — nothing was sent.", code: "USER_CANCELLED" } } };
      }),
    );
  }

  /** Clears the live conversation back to a blank slate WITHOUT allocating a
   *  new conversation id — one gets allocated lazily, the next time the user
   *  actually sends something (see ensureConversation). The just-left
   *  conversation is untouched in storage; this only clears which one is
   *  active, so "New conversation" never deletes anything (see
   *  deleteConversationAction/clearAllHistoryAction for the actions that do). */
  function newConversation() {
    visualAddressRef.current = null;
    setMessages([]);
    setInput("");
    setPending(null);
    setProgress({});
    setAutomationDraft(null);
    activeConversationIdRef.current = null;
    activeConversationMetaRef.current = null;
    if (currentWalletRef.current) setActiveConversationPointer(currentWalletRef.current, null);
  }

  /** Reopens a previously saved conversation — loads its full record (already
   *  sanitized: any "confirming" card comes back downgraded to a safe error,
   *  same as any other restore path), makes it active, and persists which
   *  one that is. Never auto-executes anything; the existing confirm funnel
   *  still gates every actionable card exactly as it does for a fresh one. */
  function openConversation(conversationId: string) {
    const w = currentWalletRef.current;
    if (!w) return;
    const record = loadConversation(w, conversationId);
    if (!record) { refreshConversations(); return; } // vanished/invalid — resync the list, nothing else to do
    activeConversationIdRef.current = record.conversationId;
    activeConversationMetaRef.current = { conversationId: record.conversationId, createdAt: record.createdAt, titleIsCustom: record.titleIsCustom, title: record.title };
    setMessages(record.messages);
    setPending(record.pending);
    setInput("");
    setProgress({});
    setAutomationDraft(null);
    setActiveConversationPointer(w, record.conversationId);
    refreshConversations();
  }

  /** User-driven rename — after this, the auto-title deriver never
   *  overwrites it again for this conversation (see persistChat's
   *  renameConversation and ConversationRecord.titleIsCustom). */
  function renameConversationAction(conversationId: string, title: string) {
    const w = currentWalletRef.current;
    if (!w) return;
    const summaries = renameConversation(w, conversationId, title);
    setConversations(summaries);
    if (activeConversationMetaRef.current?.conversationId === conversationId) {
      activeConversationMetaRef.current.titleIsCustom = true;
      const renamed = summaries.find((s) => s.conversationId === conversationId);
      if (renamed) activeConversationMetaRef.current.title = renamed.title;
    }
  }

  /** Deletes one saved conversation. If it was the one currently on screen,
   *  falls back to a fresh blank conversation exactly like "New conversation"
   *  — never leaves a deleted conversation still displayed. Only ever
   *  removes this UI record: the underlying transaction/automation, if any,
   *  is untouched (see persistChat's deleteConversation doc). */
  function deleteConversationAction(conversationId: string) {
    const w = currentWalletRef.current;
    if (!w) return;
    const { summaries } = deleteConversation(w, conversationId);
    setConversations(summaries);
    if (activeConversationIdRef.current === conversationId) {
      setMessages([]);
      setInput("");
      setPending(null);
      setProgress({});
      setAutomationDraft(null);
      activeConversationIdRef.current = null;
      activeConversationMetaRef.current = null;
      setActiveConversationPointer(w, null);
    }
  }

  /** Wipes every saved conversation for this wallet and returns to a fresh
   *  blank one. Never touches another wallet's history, never touches
   *  on-chain data or the automation store. */
  function clearHistoryAction() {
    const w = currentWalletRef.current;
    if (!w) return;
    clearAllHistory(w);
    setConversations([]);
    setMessages([]);
    setInput("");
    setPending(null);
    setProgress({});
    setAutomationDraft(null);
    activeConversationIdRef.current = null;
    activeConversationMetaRef.current = null;
  }

  /** Local-only search over this wallet's conversations (title + message
   *  text) — see persistChat's searchConversations. An empty query returns
   *  the full list unfiltered, so the caller doesn't need special-case
   *  logic for "nothing typed yet". */
  function searchConversationsAction(query: string): ConversationSummary[] {
    const w = currentWalletRef.current;
    if (!w) return [];
    if (!query.trim()) return conversations;
    return searchConversations(w, query);
  }

  return {
    wallet, messages, input, setInput, thinking, thinkingLabel, thinkingHint, thinkingStartedAt, progress,
    send, sendVisual, retryThinking, editRequest, advanceOperation, retryOperation, cancelOperation, newConversation,
    automationDraft, closeAutomationDraft, completeAutomationDraft,
    // P1.3 — conversation history (only meaningful when persist: true; for
    // CommandBar's non-persisted instance this stays an empty, inert list).
    conversations, activeConversationId: activeConversationIdRef.current,
    openConversation, renameConversationAction, deleteConversationAction, clearHistoryAction,
    searchConversationsAction,
  };
}
