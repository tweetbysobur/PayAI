"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { RotateCw } from "lucide-react";
import { AskMark } from "@/components/AskMark";
import { OperationCard } from "@/components/ask/OperationCard";
import { PlanCard } from "@/components/ask/PlanCard";
import { RoomAskCard } from "@/components/ask/RoomAskCard";
import type { AskMessage } from "@/lib/ask/types";

export function ChatMessageRow({
  message,
  onAdvanceOperation,
  onCancelOperation,
  onRetryOperation,
  onQuickAction,
  progressLabel,
  onEditPlan,
}: {
  message: AskMessage;
  /** Accepted for callers; rows no longer render avatars. */
  walletAddress?: string | null;
  onAdvanceOperation: (operationId: string) => void;
  onCancelOperation: (operationId: string) => void;
  onRetryOperation?: (operationId: string) => void;
  /** Sends a follow-up as if typed — powers the Buy/Sell/Refresh quick
   *  actions on a token intelligence card. See OperationCard's own doc. */
  onQuickAction?: (text: string) => void;
  /** What's happening RIGHT NOW if this message's card is mid-execution —
   *  see useAskChat's `progress` map. Undefined outside "confirming". */
  progressLabel?: string;
  /** Edit on a plan card: puts its request back in the composer. */
  onEditPlan?: (text: string) => void;
}) {
  const isUser = message.role === "user";
  const hasCard = !!message.operation || !!message.plan || !!message.room;
  if (isUser) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }} className="flex justify-end">
        <p className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-border bg-input px-3.5 py-2 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] sm:max-w-[75%]">
          {message.content}
        </p>
      </motion.div>
    );
  }
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex items-start gap-2.5">
      <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center text-primary-ink" aria-hidden>
        <AskMark size={14} />
      </span>
      <div className={`flex min-w-0 flex-1 flex-col gap-2.5 ${hasCard ? "" : "sm:max-w-[75%]"}`}>
        {message.content && (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{message.content}</p>
        )}
        {message.operation && (
          <OperationCard
            operation={message.operation}
            onAdvance={onAdvanceOperation}
            onCancel={onCancelOperation}
            onRetry={onRetryOperation}
            onQuickAction={onQuickAction}
            progressLabel={progressLabel}
          />
        )}
        {message.plan && <PlanCard planRef={message.plan} onEdit={onEditPlan} />}
        {message.room && <RoomAskCard room={message.room} messageId={message.id} />}
      </div>
    </motion.div>
  );
}

/** After this long, the row says what is still being done. */
export const THINKING_SLOW_MS = 3_000;
/** After this long, the row offers a retry. */
export const THINKING_STALL_MS = 5_000;

/** The state between a sent message and its reply. `label` names what is
 *  actually in flight ("Preparing your transfer") — never a value. With
 *  `startedAt`, it grows with the wait: from 3 s it adds `hint` (the step
 *  still running), and at 5 s it says so plainly and offers `onRetry`, which
 *  the caller makes safe to press (no duplicate request or plan). */
export function ThinkingRow({ label, hint, startedAt, onRetry }: {
  label?: string | null;
  hint?: string | null;
  startedAt?: number | null;
  onRetry?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [startedAt]);
  const waited = startedAt ? now - startedAt : 0;
  const slow = waited >= THINKING_SLOW_MS;
  const stalled = waited >= THINKING_STALL_MS;
  // The row grows at 3 s and 5 s; keep that new line (and Retry) in view —
  // the conversation only auto-scrolls when a message is added.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (slow || stalled) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [slow, stalled]);

  return (
    <motion.div ref={rowRef} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }} className="flex items-start gap-2.5">
      <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center text-primary-ink" aria-hidden>
        <AskMark size={14} />
      </span>
      <div className="min-w-0 flex-1" role="status" aria-live="polite">
        <p className="flex items-center gap-2 text-sm text-foreground">
          <span>{label || "Working on it"}</span>
          {!stalled && (
            <span className="flex items-center gap-[3px]" aria-hidden>
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="h-1 w-1 rounded-full bg-muted-foreground"
                  animate={{ opacity: [0.25, 1, 0.25] }}
                  transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
                />
              ))}
            </span>
          )}
        </p>
        {slow && !stalled && hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        {stalled && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-xs text-muted-foreground">{onRetry ? "This is taking longer than usual." : "This is taking longer than usual. Still working."}</p>
            {onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCw size={12} aria-hidden />Retry
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
