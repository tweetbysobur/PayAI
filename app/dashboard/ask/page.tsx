"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { AskEmptyState, CAPABILITY_SHORTCUTS } from "@/components/ask/AskEmptyState";
import { ChatMessageRow, ThinkingRow } from "@/components/ask/ChatMessage";
import { ChatComposer } from "@/components/ask/ChatComposer";
import { executeSendPayment } from "@/lib/ask/sendPayment/orchestrator";
import {
  classifyMessage, executeSwapIntent, handoffToAutomations, respondToUnderstanding,
  type ConversationTurn,
} from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";
import type { AskMessage } from "@/lib/ask/types";

/** send_payment, swap, schedule/recurring handoff, balance, history, and
 *  automation listing all run through the real PayAI pipeline now — see
 *  lib/ask/intent/. Flip this back to `true` to hide the page again behind
 *  a "coming soon" placeholder without removing any code. */
const COMING_SOON = false;

function AskComingSoon() {
  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
          <Sparkles size={15} />
        </span>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Ask PayAI</h1>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl border border-border bg-panel/40 px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"
        >
          <Sparkles size={26} />
        </motion.div>
        <motion.h2
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.35 }}
          className="mt-4 text-2xl font-semibold tracking-tight text-foreground"
        >
          Coming soon
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.35 }}
          className="mt-2 max-w-md text-center text-sm leading-relaxed text-muted-foreground"
        >
          We&apos;re building natural-language payments — tell PayAI what you want in your own words, and it
          prepares it for your review, with nothing moving until you confirm and sign. Check back soon.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.35 }}
          className="mt-8 flex flex-wrap items-center justify-center gap-2"
        >
          {CAPABILITY_SHORTCUTS.map((s, i) => {
            const Icon = s.icon;
            return (
              <motion.div
                key={s.label}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.18 + i * 0.04, duration: 0.3 }}
                className="flex items-center gap-1.5 rounded-full border border-border bg-panel px-3.5 py-1.5 text-xs font-medium text-muted-foreground opacity-60"
              >
                <Icon size={13} />
                {s.label}
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </div>
  );
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now()}_${idSeq}`;
}

/** Canonical text for a retry — always rebuilt from the operation's own
 *  validated fields, never a stored raw string that might now be stale. */
function retryTextFor(op: NonNullable<AskMessage["operation"]>): string | null {
  if (op.intent.kind === "payment" && op.intent.execution) return op.intent.execution.confirmRawText;
  if (op.intent.kind === "swap" && op.intent.execution) return `Swap ${op.intent.fromAmount} ${op.intent.fromToken} to ${op.intent.toToken}`;
  return null;
}

function AskPayAIChat() {
  const wallet = useWallet();
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  // The in-flight, not-yet-complete (or just-completed) intent — carried
  // into the next turn so "20", "MON", or "actually make it 30" is
  // understood as continuing/correcting THIS request rather than starting
  // an unrelated new one. See lib/ask/intent/classify.ts.
  const [pending, setPending] = useState<Understanding | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
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
    if (op.intent.kind === "swap" && op.intent.execution && wallet.address) {
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

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
            <Sparkles size={15} />
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Ask PayAI</h1>
        </div>
        {messages.length > 0 && (
          <button
            onClick={newConversation}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            New conversation
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-panel/40">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <AskEmptyState onPick={send} />
          ) : (
            <div role="log" aria-live="polite" aria-label="Conversation with Ask PayAI" className="space-y-4 p-4 sm:p-6">
              {messages.map((m) => (
                <ChatMessageRow
                  key={m.id}
                  message={m}
                  walletAddress={wallet.address}
                  onAdvanceOperation={advanceOperation}
                  onCancelOperation={cancelOperation}
                  onRetryOperation={retryOperation}
                />
              ))}
              {thinking && <ThinkingRow />}
            </div>
          )}
        </div>

        <ChatComposer value={input} onChange={setInput} onSend={() => send(input)} disabled={thinking} />
      </div>
    </div>
  );
}

export default function AskPayAIPage() {
  return COMING_SOON ? <AskComingSoon /> : <AskPayAIChat />;
}
