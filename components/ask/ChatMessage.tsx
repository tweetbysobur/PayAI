"use client";

import { motion } from "motion/react";
import { Sparkles, User } from "lucide-react";
import { Identicon } from "@/components/Identicon";
import { OperationCard } from "@/components/ask/OperationCard";
import type { AskMessage } from "@/lib/ask/types";

export function ChatMessageRow({
  message,
  walletAddress,
  onAdvanceOperation,
  onCancelOperation,
  onRetryOperation,
  progressLabel,
}: {
  message: AskMessage;
  walletAddress?: string | null;
  onAdvanceOperation: (operationId: string) => void;
  onCancelOperation: (operationId: string) => void;
  onRetryOperation?: (operationId: string) => void;
  /** What's happening RIGHT NOW if this message's card is mid-execution —
   *  see useAskChat's `progress` map. Undefined outside "confirming". */
  progressLabel?: string;
}) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}
      className={`flex items-start gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full ${isUser ? "bg-input text-muted-foreground" : "bg-primary/12 text-primary-ink"}`}>
        {isUser ? (walletAddress ? <Identicon address={walletAddress} size={28} /> : <User size={13} />) : <Sparkles size={13} />}
      </span>
      <div className={`flex min-w-0 max-w-[88%] flex-col gap-2 sm:max-w-[75%] ${isUser ? "items-end" : "items-start"}`}>
        {message.content && (
          <div
            className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              isUser
                ? "rounded-tr-sm bg-primary text-primary-foreground"
                : "rounded-tl-sm border border-border bg-panel text-foreground"
            }`}
          >
            {message.content}
          </div>
        )}
        {message.operation && (
          <OperationCard
            operation={message.operation}
            onAdvance={onAdvanceOperation}
            onCancel={onCancelOperation}
            onRetry={onRetryOperation}
            progressLabel={progressLabel}
          />
        )}
      </div>
    </motion.div>
  );
}

/** The "PayAI is thinking" state between a sent message and its reply. */
export function ThinkingRow() {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary-ink">
        <Sparkles size={13} />
      </span>
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm border border-border bg-panel px-4 py-3">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
          />
        ))}
      </div>
    </motion.div>
  );
}
