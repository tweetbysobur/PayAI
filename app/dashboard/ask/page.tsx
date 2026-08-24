"use client";

import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { AskMark, AskLogo } from "@/components/AskMark";
import { AskEmptyState, CAPABILITY_SHORTCUTS } from "@/components/ask/AskEmptyState";
import { ChatMessageRow, ThinkingRow } from "@/components/ask/ChatMessage";
import { ChatComposer } from "@/components/ask/ChatComposer";
import { retryTextFor } from "@/lib/ask/useAskChat";
import { useAskPageChat } from "@/lib/ask/AskPageChatContext";

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
          <AskMark size={16} />
        </span>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Ask PayAI</h1>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl border border-border bg-panel/40 px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
          className="text-primary"
        >
          <AskLogo size={56} />
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

function AskPayAIChat() {
  const {
    wallet, messages, input, setInput, thinking, thinkingLabel, progress,
    send, advanceOperation, retryOperation, cancelOperation, newConversation,
  } = useAskPageChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col">
      <div className="mb-3 flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
            <AskMark size={16} />
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
                  onQuickAction={send}
                  // Only offer "Try again" where retrying actually does
                  // something — a schedule/recurring handoff card (or any
                  // future kind without a canonical retry text) would
                  // otherwise show a button that silently does nothing.
                  onRetryOperation={m.operation && retryTextFor(m.operation) ? retryOperation : undefined}
                  progressLabel={m.operation ? progress[m.operation.id] : undefined}
                />
              ))}
              {thinking && <ThinkingRow label={thinkingLabel} />}
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
