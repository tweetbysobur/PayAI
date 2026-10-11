/**
 * Payments PayAI's risk check stopped ("needs_review" records).
 *
 * Such a record means the payment was NOT sent: an automation run scored high
 * risk (lib/automation/execute.ts records it and moves nothing), or an older
 * interactive request was refused the same way. There is no manual-review
 * step anywhere (lib/platform/schedules.ts) — nothing is held, nothing is
 * waiting, and nothing will be released later. Every screen says exactly that.
 *
 * Pure; no imports.
 */

/** The status word for a stopped payment, in history and feeds. */
export const STOPPED_LABEL = "Stopped";

/** How long a stopped payment keeps the dashboard warning up. Older ones stay
 *  in history; they just stop asking for attention. */
export const RECENT_STOPPED_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoppedNotice {
  count: number;
  title: string;
  detail: string;
  href: string;
}

export function stoppedNotice(history: { decision: string; at: number }[], now = Date.now()): StoppedNotice | null {
  const count = history.filter((h) => h.decision === "needs_review" && now - h.at <= RECENT_STOPPED_MS).length;
  if (count === 0) return null;
  return {
    count,
    title: count === 1 ? "1 payment was stopped by the risk check" : `${count} payments were stopped by the risk check`,
    detail: "Nothing was sent. If you meant to pay, send it again (a smaller amount or a named recipient scores lower), or adjust the automation.",
    href: "/dashboard/transactions?status=needs_review",
  };
}
