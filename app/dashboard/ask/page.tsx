"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Plus } from "lucide-react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { AskEmptyState } from "@/components/ask/AskEmptyState";
import { ChatMessageRow, ThinkingRow } from "@/components/ask/ChatMessage";
import { ChatComposer } from "@/components/ask/ChatComposer";
import { mockRespond } from "@/lib/ask/mockAgent";
import type { AskMessage, Operation, TransactionResult } from "@/lib/ask/types";

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

export default function AskPayAIPage() {
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
    // A believable, varied thinking delay — mocked, but never instant, so the
    // pipeline-verification framing (this is checking things, not just
    // echoing) reads true even before real latency exists.
    await new Promise((r) => setTimeout(r, 550 + Math.random() * 450));
    const reply = await mockRespond(trimmed);
    setThinking(false);
    setMessages((m) => [...m, reply]);
  }

  /** Advances a card exactly one step per click — preview -> ready, or
   *  ready -> confirming (which then resolves on its own after a beat, the
   *  one place time passes without a click, standing in for the real
   *  passkey/wallet round trip). Never skips a step, never both attaches a
   *  result AND changes status in reaction to anything but this call. */
  function advanceOperation(operationId: string) {
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
   *  disappear, only the "I'm ready" step should reset. */
  function cancelOperation(operationId: string) {
    setMessages((prev) =>
      prev.map((m) => (m.operation?.id === operationId ? { ...m, operation: { ...m.operation, status: "preview" } } : m)),
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
            <Plus size={13} /> New conversation
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
