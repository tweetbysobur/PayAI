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
import { useState } from "react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { executeSendPayment } from "@/lib/ask/sendPayment/orchestrator";
import {
  classifyMessage, executeSwapIntent, executeTradeIntent, respondToUnderstanding,
  type ConversationTurn,
} from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";
import type { AskMessage, Operation } from "@/lib/ask/types";
import type { AutomationSeed, Cadence } from "@/components/dashboard/automationShared";

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

export function useAskChat() {
  const wallet = useWallet();
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
    const notice: AskMessage = { id: nextId("msg"), role: "assistant", content: "That quote has expired. I'll get you a fresh quote.", createdAt: Date.now() };
    setMessages((m) => [...m, notice]);
    const understanding: Understanding = { kind: "swap", outcome: "complete", slots: { amount: intent.fromAmount, fromAsset: intent.fromToken, toAsset: intent.toToken } };
    const { message } = await respondToUnderstanding(understanding, wallet.address);
    setMessages((m) => [...m, message]);
  }

  /** Re-quotes a trade whose preview has gone stale — built entirely from
   *  the expired card's own already-known action/pair/amount, so this never
   *  needs a fresh Anthropic call just to ask for the exact same thing
   *  again. Mirrors requoteExpiredSwap above. */
  async function requoteExpiredTrade(intent: Extract<Operation["intent"], { kind: "trade_preview" }>) {
    const notice: AskMessage = { id: nextId("msg"), role: "assistant", content: "That quote has expired. I'll get you a fresh quote.", createdAt: Date.now() };
    setMessages((m) => [...m, notice]);
    const req = intent.execution?.request;
    const understanding: Understanding = req
      ? { kind: "trade", outcome: "complete", slots: { tradeAction: req.action, fromAsset: req.inputToken, toAsset: req.outputToken, amount: req.amount, amountType: req.amountType, slippage: req.slippage } }
      : { kind: "trade", outcome: "complete", slots: { tradeAction: intent.data.action, fromAsset: intent.data.spend.token, toAsset: intent.data.receive.token, amount: intent.data.spend.amount, amountType: "exact_input", slippage: null } };
    const { message } = await respondToUnderstanding(understanding, wallet.address);
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
    setMessages((m) => [...m, message]);
  }

  /** "What's the price now?" — a genuinely fresh market-data lookup (never
   *  the trade's own now-stale quote) for whichever token is currently in
   *  context, via the exact same real token_lookup path a pasted contract
   *  address already uses. */
  async function answerPriceNow(userMsg: AskMessage) {
    setMessages((m) => [...m, userMsg]);
    setInput("");
    const address = findCurrentTokenAddress(messages);
    if (!address) {
      const understanding = await classifyMessage(userMsg.content, [...messages, userMsg].slice(-8).map((m) => ({ role: m.role, content: m.content })), pending);
      const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);
      setPending(nextPending);
      setMessages((m) => [...m, message]);
      return;
    }
    const understanding: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: address } };
    const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);
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
