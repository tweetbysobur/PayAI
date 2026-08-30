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
 * cancelling a card, and starting over.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { executeSendPayment } from "@/lib/ask/sendPayment/orchestrator";
import {
  classifyMessage, executeSwapIntent, executeTradeIntent, respondToUnderstanding,
  type ConversationTurn,
} from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";
import type { AskMessage, Operation } from "@/lib/ask/types";
import type { AutomationSeed, Cadence } from "@/components/dashboard/automationShared";
import { loadChatState, normalizeWalletAddress, saveChatState } from "@/lib/ask/persistChat";

/** Details the in-chat AutomationCreator modal returns on a real creation. */
export type CreatedAutomation = { nextRun: number; cadence: Cadence; amount: number; token: string; recipient: string; domain: string | null };

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now()}_${idSeq}`;
}

/** Canonical text for a retry — always rebuilt from the operation's own
 *  validated fields, never a stored raw string that might now be stale. */
export function retryTextFor(op: NonNullable<AskMessage["operation"]>): string | null {
  if (op.intent.kind === "payment" && op.intent.execution) return op.intent.execution.confirmRawText;
  if (op.intent.kind === "swap" && op.intent.execution) return `Swap ${op.intent.fromAmount} ${op.intent.fromToken} to ${op.intent.toToken}`;
  if (op.intent.kind === "trade_preview") {
    const d = op.intent.data;
    return `${d.action === "buy" ? "Buy" : "Sell"} ${d.spend.amount} ${d.spend.token} for ${d.receive.token}`;
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

/** Same shape as classify.ts's own EVM_ADDRESS_RE, duplicated (not imported)
 *  deliberately: classify.ts pulls in the Anthropic SDK and other
 *  server-only weight this client bundle shouldn't carry just for one
 *  regex. Used only to pick a more specific loading label — never to
 *  change what gets sent or how it's classified server-side. */
const CLIENT_EVM_ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

/**
 * `persist: true` survives a browser refresh via sessionStorage (see
 * lib/ask/persistChat.ts) — opt-in, and only ever passed by
 * AskPageChatContext for the full /dashboard/ask page's conversation.
 * CommandBar's own useAskChat() call is a deliberately separate conversation
 * (see AskPageChatContext's doc) and leaves this false, so its popup thread
 * never reads or writes the page's storage slot (or vice versa).
 */
export function useAskChat(options?: { persist?: boolean }) {
  const persist = options?.persist ?? false;
  const wallet = useWallet();
  // Both start EMPTY on every render path, server included — never read
  // sessionStorage inside a lazy initializer here. This page is still
  // server-rendered for its first HTML (a plain "use client" page doesn't
  // opt out of that), and the server obviously has no sessionStorage; seeding
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

  // Mirrors messages/pending into sessionStorage after every change (see
  // lib/ask/persistChat.ts) — nothing else here needs to survive a refresh:
  // `progress` is only ever meaningful while a request this same page load
  // made is still in flight, and `automationDraft` is just whether the modal
  // is open, fully reconstructible from the operation's own handoff prefill
  // (see advanceOperation below) — so a refresh naturally leaves the modal
  // closed rather than reopening it unprompted, without losing any real data.
  // P1.2: which wallet identity the in-memory messages/pending currently
  // belong to — normalized the same way persistChat.ts does, so `null` means
  // either "no wallet connected" or "not yet reconciled". Saves always write
  // under THIS, never under whatever `wallet.address` happens to read as at
  // save time, which matters the instant a wallet change is in flight (see
  // the reconcile effect below): by the time it changes, that effect has
  // already updated it synchronously, so a save that fires afterward can
  // never attribute one wallet's data to another's key.
  const currentWalletRef = useRef<string | null>(null);

  /** True when the connected wallet has changed since `startWallet` was
   *  captured at the top of an async function — i.e. that function's result
   *  is about to land after the user already switched to (or away from) a
   *  different wallet. Every function below that appends a brand-new
   *  message or replaces `pending` after an `await` checks this first and
   *  bails out silently if stale, so a slow response begun under one wallet
   *  can never surface in a DIFFERENT wallet's visible conversation. (An
   *  update that instead modifies an EXISTING message by operation id — e.g.
   *  advanceOperation's setOp, or completeAutomationDraft — doesn't need this
   *  guard: operation ids are globally unique, so that kind of update is
   *  already a no-op once the message array has been swapped out from under
   *  it.) Always false when persistence is off (CommandBar's popup):
   *  currentWalletRef never leaves null there, so this can never trip —
   *  unchanged from today's behavior for that surface. */
  function isStaleWallet(startWallet: string | null): boolean {
    return currentWalletRef.current !== startWallet;
  }

  useEffect(() => {
    if (!persist || !restoredRef.current) return;
    saveChatState(messages, pending, currentWalletRef.current);
  }, [persist, messages, pending]);

  // Restores the CONNECTED WALLET's own persisted conversation — on mount,
  // and again every time the connected wallet identity changes (connecting
  // for the first time, disconnecting, or switching to a different wallet;
  // see lib/wallet/useWallet.tsx's accountsChanged handling for how
  // wallet.address itself updates live). Client-only, so the server-rendered
  // (always-empty) first paint is never contradicted (see the state
  // declarations' own doc above).
  //
  // P1.2's actual safety property lives here: every distinct value of
  // wallet.address — including null, "no wallet" — is its own identity
  // bucket. Switching buckets always reloads from scratch for the NEW
  // identity (that wallet's own record, or a clean conversation if it has
  // none) and never carries the OLD bucket's messages/pending along — so a
  // conversation started before connecting, or under a different wallet,
  // can never resurface under a wallet that didn't produce it. The OLD
  // bucket's own data isn't lost if it was a real wallet: the save effect
  // above already wrote every change to ITS OWN key throughout, so it's
  // sitting in storage exactly where switching back to it will find it
  // (still subject to the existing TTL).
  //
  // Never restores mid-execution state as executable: loadChatState itself
  // downgrades any "confirming" card to a safe error before this ever sees
  // it (see lib/ask/persistChat.ts's sanitizeOperation) — nothing here can
  // revive a signature or a broadcast, only redisplay already-safe
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
    if (!persist) { restoredRef.current = true; return; }
    const normalized = normalizeWalletAddress(wallet.address);
    currentWalletRef.current = normalized;
    const restored = normalized ? loadChatState(normalized) : null;
    setMessages(restored?.messages ?? []);
    setPending(restored?.pending ?? null);
    restoredRef.current = true;
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
    const startWallet = currentWalletRef.current;
    const notice: AskMessage = { id: nextId("msg"), role: "assistant", content: "That quote has expired. I'll get you a fresh quote.", createdAt: Date.now() };
    setMessages((m) => [...m, notice]);
    const understanding: Understanding = { kind: "swap", outcome: "complete", slots: { amount: intent.fromAmount, fromAsset: intent.fromToken, toAsset: intent.toToken } };
    const { message } = await respondToUnderstanding(understanding, wallet.address);
    if (isStaleWallet(startWallet)) return;
    setMessages((m) => [...m, message]);
  }

  /** Re-quotes a trade whose preview has gone stale — built entirely from
   *  the expired card's own already-known action/pair/amount, so this never
   *  needs a fresh Anthropic call just to ask for the exact same thing
   *  again. Mirrors requoteExpiredSwap above. */
  async function requoteExpiredTrade(intent: Extract<Operation["intent"], { kind: "trade_preview" }>) {
    const startWallet = currentWalletRef.current;
    const notice: AskMessage = { id: nextId("msg"), role: "assistant", content: "That quote has expired. I'll get you a fresh quote.", createdAt: Date.now() };
    setMessages((m) => [...m, notice]);
    const req = intent.execution?.request;
    const understanding: Understanding = req
      ? { kind: "trade", outcome: "complete", slots: { tradeAction: req.action, fromAsset: req.inputToken, toAsset: req.outputToken, amount: req.amount, amountType: req.amountType, slippage: req.slippage } }
      : { kind: "trade", outcome: "complete", slots: { tradeAction: intent.data.action, fromAsset: intent.data.spend.token, toAsset: intent.data.receive.token, amount: intent.data.spend.amount, amountType: "exact_input", slippage: null } };
    const { message } = await respondToUnderstanding(understanding, wallet.address);
    if (isStaleWallet(startWallet)) return;
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
    const startWallet = currentWalletRef.current;
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
    if (isStaleWallet(startWallet)) return;
    setMessages((m) => [...m, message]);
  }

  /** "What's the price now?" — a genuinely fresh market-data lookup (never
   *  the trade's own now-stale quote) for whichever token is currently in
   *  context, via the exact same real token_lookup path a pasted contract
   *  address already uses. */
  async function answerPriceNow(userMsg: AskMessage) {
    const startWallet = currentWalletRef.current;
    setMessages((m) => [...m, userMsg]);
    setInput("");
    const address = findCurrentTokenAddress(messages);
    if (!address) {
      const understanding = await classifyMessage(userMsg.content, [...messages, userMsg].slice(-8).map((m) => ({ role: m.role, content: m.content })), pending);
      const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);
      if (isStaleWallet(startWallet)) return;
      setPending(nextPending);
      setMessages((m) => [...m, message]);
      return;
    }
    const understanding: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: address } };
    const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);
    if (isStaleWallet(startWallet)) return;
    setPending(nextPending);
    setMessages((m) => [...m, message]);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
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

    const startWallet = currentWalletRef.current;
    const userMsg: AskMessage = { id: nextId("u"), role: "user", content: trimmed, createdAt: Date.now() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setThinkingLabel(CLIENT_EVM_ADDRESS_RE.test(trimmed) ? "Looking up token…" : null);
    setThinking(true);
    try {
      const history: ConversationTurn[] = [...messages, userMsg]
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content }));
      const understanding = await classifyMessage(trimmed, history, pending);
      const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);
      // The wallet may have changed (switched, or disconnected) while this
      // was in flight — never let a response resolved for the OLD identity
      // land in whatever's now showing for a different one. See
      // isStaleWallet's own doc.
      if (isStaleWallet(startWallet)) return;

      // A freshly-built ready card (e.g. from "actually make it 75", or a
      // corrected swap amount/token) supersedes any earlier one still
      // awaiting confirmation — the old card's unsigned transaction reflects
      // details the user just changed, so it must never stay clickable once
      // a corrected preview exists.
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
    } finally {
      setThinking(false);
    }
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
      setOp({ ...op, status: "confirming" });
      const result = await executeTradeIntent(op, wallet, wallet.address, setProgressFor);
      clearProgressFor();
      setOp(result);
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

  function newConversation() {
    setMessages([]);
    setInput("");
    setPending(null);
    setProgress({});
    setAutomationDraft(null);
  }

  return {
    wallet, messages, input, setInput, thinking, thinkingLabel, progress,
    send, advanceOperation, retryOperation, cancelOperation, newConversation,
    automationDraft, closeAutomationDraft, completeAutomationDraft,
  };
}
