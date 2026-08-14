"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, Clock3, Wallet, ArrowLeftRight, Users, Search } from "lucide-react";
import { motion } from "motion/react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { AskEmptyState } from "@/components/ask/AskEmptyState";
import { ChatMessageRow, ThinkingRow } from "@/components/ask/ChatMessage";
import { ChatComposer } from "@/components/ask/ChatComposer";
import { mockRespond } from "@/lib/ask/mockAgent";
import { executeSendPayment, respondToSendPayment } from "@/lib/ask/sendPayment/orchestrator";
import type { AskMessage, Operation, TransactionResult } from "@/lib/ask/types";

/** send_payment (MON/USDC) now runs through the real PayAI pipeline — see
 *  lib/ask/sendPayment/. Flip this back to `true` to hide the page again
 *  behind a "coming soon" placeholder without removing any code. */
const COMING_SOON = false;

const PREVIEW_PROMPTS: { label: string; icon: typeof Send }[] = [
  { label: "Send a payment", icon: Send },
  { label: "Schedule a payment", icon: Clock3 },
  { label: "Check my balance", icon: Wallet },
  { label: "Swap tokens", icon: ArrowLeftRight },
  { label: "Distribute to multiple wallets", icon: Users },
  { label: "Explain my last transaction", icon: Search },
];

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
          We&apos;re building natural-language payments — describe what you want in plain English and PayAI
          prepares it for your review, with nothing moving until you confirm and sign. Check back soon.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.35 }}
          className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2"
        >
          {PREVIEW_PROMPTS.map((p, i) => {
            const Icon = p.icon;
            return (
              <motion.div
                key={p.label}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.18 + i * 0.04, duration: 0.3 }}
                className="flex items-center gap-3 rounded-xl border border-border bg-panel px-4 py-3.5 opacity-60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-input text-muted-foreground">
                  <Icon size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{p.label}</span>
                </span>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </div>
  );
}

/** Placeholder for the real settlement result the execution layer will
 *  eventually return. Shaped identically to what /api/agent already
 *  produces elsewhere in the app (see lib/hooks/useAgentConsole.ts), so
 *  swapping this out later is a data-source change, not a UI one. */
function mockTxResult(): TransactionResult {
  const hex = "0123456789abcdef";
  const hash = `0x${Array.from({ length: 64 }, () => hex[Math.floor(Math.random() * 16)]).join("")}`;
  return { txHash: hash, explorerUrl: `https://explorer.monad.xyz/tx/${hash}`, gasFee: "0.0008 MON" };
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now()}_${idSeq}`;
}

function AskPayAIChat() {
  const wallet = useWallet();
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
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
      // send_payment is the only intent this phase runs for real — through
      // the exact same /api/agent + /api/agent/confirm pipeline the rest of
      // the dashboard uses. respondToSendPayment returns null for anything
      // that isn't send-payment-shaped, so every other intent this phase
      // doesn't implement (swap, schedule, distribute, balance...) still
      // falls through to the existing mock layer below, unchanged.
      const real = await respondToSendPayment(trimmed, wallet.address);
      if (real) {
        setMessages((m) => [...m, real]);
        return;
      }
      // A believable, varied thinking delay — mocked, but never instant, so
      // the pipeline-verification framing (this is checking things, not
      // just echoing) reads true even before real latency exists. Only
      // applied to the still-mocked intents; the real path above has its
      // own genuine network latency and doesn't need one added on top.
      await new Promise((r) => setTimeout(r, 550 + Math.random() * 450));
      const reply = await mockRespond(trimmed);
      setMessages((m) => [...m, reply]);
    } finally {
      setThinking(false);
    }
  }

  /** Advances a card exactly one step per click. A real send_payment card
   *  (operation.intent.execution present) skips straight from "ready" —
   *  set the moment /api/agent already approved it — through the real
   *  wallet/passkey signature and settlement via executeSendPayment(); every
   *  other (still-mocked) kind keeps the original preview -> ready ->
   *  confirming demo behavior untouched. Never skips a step, never both
   *  attaches a result AND changes status in reaction to anything but a
   *  real user click. */
  async function advanceOperation(operationId: string) {
    const current = messages.find((m) => m.operation?.id === operationId)?.operation;
    if (current?.intent.kind === "payment" && current.intent.execution) {
      if (current.status !== "ready") return;
      setMessages((prev) =>
        prev.map((m) => (m.operation?.id === operationId ? { ...m, operation: { ...m.operation!, status: "confirming" } } : m)),
      );
      const result = await executeSendPayment(current, wallet);
      setMessages((prev) => prev.map((m) => (m.operation?.id === operationId ? { ...m, operation: result } : m)));
      return;
    }

    setMessages((prev) =>
      prev.map((m) => {
        if (m.operation?.id !== operationId) return m;
        const op = m.operation;
        if (op.status === "preview") return { ...m, operation: { ...op, status: "ready" } };
        if (op.status === "ready") {
          setTimeout(() => resolveOperation(operationId), 1300);
          return { ...m, operation: { ...op, status: "confirming" } };
        }
        return m;
      }),
    );
  }

  /** Re-runs the original request from scratch through the real pipeline —
   *  never resubmits a stale signed artifact. Only wired up for real
   *  send_payment cards (see the OperationCard onRetry prop below); a fresh
   *  /api/agent call re-validates against current balances/state instead of
   *  blindly retrying whatever failed. */
  function retryOperation(operationId: string) {
    const op = messages.find((m) => m.operation?.id === operationId)?.operation;
    const rawText = op?.intent.kind === "payment" ? op.intent.execution?.confirmRawText : null;
    if (rawText) void send(rawText);
  }

  /** The demo's stand-in for a real execution failure (compliance block, a
   *  reverted transaction, an expired quote). Deterministic on amount rather
   *  than random, so the error-state UI is something a reviewer can actually
   *  reach on demand instead of hoping for an unlucky roll: try a number
   *  over 10,000 in any of the transactional flows. */
  function mockAmount(intent: Operation["intent"]): number {
    switch (intent.kind) {
      case "payment": case "scheduled_payment": case "recurring_payment": return Number(intent.amount);
      case "swap": return Number(intent.fromAmount);
      case "distribution": return Number(intent.totalAmount);
      case "wallet_operation": return 0;
    }
  }

  function resolveOperation(operationId: string) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.operation?.id !== operationId) return m;
        const overLimit = mockAmount(m.operation.intent) > 10_000;
        return {
          ...m,
          operation: overLimit
            ? { ...m.operation, status: "error", error: { message: "This exceeds your daily limit and was blocked before signing. No funds moved.", code: "LIMIT_EXCEEDED" } }
            : { ...m.operation, status: "success", result: mockTxResult() },
        };
      }),
    );
  }

  /** Cancelling a not-yet-confirmed card returns it to review rather than
   *  destroying it — the details the user already reviewed shouldn't
   *  disappear, only the "I'm ready" step should reset. A real send_payment
   *  card never had a "preview" step (it starts at "ready", already
   *  server-approved), so cancelling it ends the card instead — no
   *  signature was ever requested, so there's nothing to undo. */
  function cancelOperation(operationId: string) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.operation?.id !== operationId) return m;
        const op = m.operation;
        if (op.intent.kind === "payment" && op.intent.execution) {
          return { ...m, operation: { ...op, status: "error", error: { message: "Cancelled — nothing was sent.", code: "USER_CANCELLED" } } };
        }
        return { ...m, operation: { ...op, status: "preview" } };
      }),
    );
  }

  function newConversation() {
    setMessages([]);
    setInput("");
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
