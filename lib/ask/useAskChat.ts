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
  classifyMessage, executeSwapIntent, handoffToAutomations, respondToUnderstanding,
  type ConversationTurn,
} from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";
import type { AskMessage, Operation } from "@/lib/ask/types";

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
  return null;
}

/** Matches ONLY a bare, unambiguous confirmation — "yes", "confirm", "send
 *  it", "do it", close variants, and a comma-joined combination of them
 *  ("Yes, send it.") — nothing more. Deliberately not routed through the AI
 *  classifier: whether a message counts as authorization is a fixed,
 *  deterministic decision, not something an LLM's interpretation could ever
 *  loosen or bypass. A message that introduces anything beyond these exact
 *  phrases ("yes, but make it 30") intentionally does NOT match — see the
 *  correction handling in classify.ts instead. */
const AFFIRMATION_WORD = "(?:yes|yeah|yep|yup|confirm(?:ed)?|do it|send it|go ahead|proceed)";
export const AFFIRMATION_RE = new RegExp(`^${AFFIRMATION_WORD}(?:\\s*,?\\s*${AFFIRMATION_WORD})*[.!]*$`, "i");

/** The most recent still-unsigned, server-approved payment card — the only
 *  thing a bare "yes" is ever allowed to authorize. Undefined when nothing
 *  is actually awaiting confirmation, so "yes" out of nowhere is never
 *  misread as an authorization (see send()'s guard below). */
export function findReadyPaymentOperation(messages: AskMessage[]): Operation | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const op = messages[i].operation;
    if (op?.status === "ready" && op.intent.kind === "payment") return op;
  }
  return undefined;
}

export function useAskChat() {
  const wallet = useWallet();
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // The in-flight, not-yet-complete (or just-completed) intent — carried
  // into the next turn so "20", "MON", or "actually make it 30" is
  // understood as continuing/correcting THIS request rather than starting
  // an unrelated new one. See lib/ask/intent/classify.ts.
  const [pending, setPending] = useState<Understanding | null>(null);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;

    // Natural-language confirmation of an already-previewed payment. Checked
    // BEFORE anything is sent to the AI: whether this message authorizes a
    // real payment is decided here, deterministically, against a card this
    // module already built and the server already approved — never by
    // asking the model to decide it. No matching card means "yes" is just a
    // stray word, never a payment authorization (see AFFIRMATION_RE's doc).
    const readyPayment = findReadyPaymentOperation(messages);
    if (readyPayment && AFFIRMATION_RE.test(trimmed)) {
      const userMsg: AskMessage = { id: nextId("u"), role: "user", content: trimmed, createdAt: Date.now() };
      setMessages((m) => [...m, userMsg]);
      setInput("");
      await advanceOperation(readyPayment.id);
      return;
    }

    const userMsg: AskMessage = { id: nextId("u"), role: "user", content: trimmed, createdAt: Date.now() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setThinking(true);
    try {
      const history: ConversationTurn[] = [...messages, userMsg]
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content }));
      const understanding = await classifyMessage(trimmed, history, pending);
      const { message, nextPending } = await respondToUnderstanding(understanding, wallet.address);

      // A freshly-built ready payment card (e.g. from "actually make it 75")
      // supersedes any earlier one still awaiting confirmation — the old
      // card's unsigned transaction reflects details the user just changed,
      // so it must never stay clickable once a corrected preview exists.
      if (
        readyPayment && readyPayment.id !== message.operation?.id &&
        message.operation?.status === "ready" && message.operation.intent.kind === "payment"
      ) {
        setMessages((prev) =>
          prev.map((m) =>
            m.operation?.id === readyPayment.id
              ? { ...m, operation: { ...m.operation, status: "error", error: { message: "Replaced by the updated payment below.", code: "SUPERSEDED" } } }
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

    if (op.intent.kind === "payment" && op.intent.execution) {
      setOp({ ...op, status: "confirming" });
      setOp(await executeSendPayment(op, wallet));
      return;
    }
    if (op.intent.kind === "swap" && op.intent.execution) {
      if (!wallet.address) {
        setOp({ ...op, status: "error", error: { message: "Your wallet disconnected — reconnect and try again.", code: "NO_WALLET" } });
        return;
      }
      setOp({ ...op, status: "confirming" });
      setOp(await executeSwapIntent(op, wallet, wallet.address));
      return;
    }
    if ((op.intent.kind === "scheduled_payment" || op.intent.kind === "recurring_payment") && op.intent.handoff) {
      setOp({ ...op, status: "confirming" });
      handoffToAutomations(op.intent.handoff); // navigates away — nothing to sign here
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
  }

  return {
    wallet, messages, input, setInput, thinking,
    send, advanceOperation, retryOperation, cancelOperation, newConversation,
  };
}
