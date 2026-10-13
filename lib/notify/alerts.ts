/**
 * Which notifications pop up on screen, and with which sound.
 *
 *   deposit   money arrived in the wallet — the celebration
 *   failure   a transaction or automation run that didn't go through
 *   activity  any other transaction anywhere in PayAI: a payment, a swap or
 *             trade, an automation run, a withdrawal
 *
 * Non-transaction notices (a wallet connected, a support ticket, an upcoming
 * run) stay in the bell without a pop-up. Pure; no I/O.
 */

export type AlertKind = "deposit" | "activity" | "failure";

export interface AlertCandidate {
  decision: string;
  at: number;
  txHash?: string;
}

const FAILURES = new Set([
  "error", "blocked", "refused", "needs_review",
  "automation_execution_failed", "automation_paused",
]);

const ACTIVITY_WITHOUT_HASH = new Set(["automation_executed", "automation_completed"]);

export function alertKind(n: AlertCandidate): AlertKind | null {
  if (n.decision === "deposit_received") return "deposit";
  if (FAILURES.has(n.decision)) return "failure";
  if (n.txHash || ACTIVITY_WITHOUT_HASH.has(n.decision)) return "activity";
  return null;
}

/** New pop-up-worthy notifications since `sinceAt`, newest first. */
export function newAlerts<T extends AlertCandidate>(items: T[], sinceAt: number): T[] {
  return items
    .filter((n) => n.at > sinceAt && alertKind(n) !== null)
    .sort((a, b) => b.at - a.at);
}

/** What to show for a batch: a deposit wins (it's the celebration), then a
 *  failure (it needs attention), then the newest activity. */
export function headline<T extends AlertCandidate>(fresh: T[]): { item: T; kind: AlertKind; more: number } | null {
  if (fresh.length === 0) return null;
  const pick =
    fresh.find((n) => alertKind(n) === "deposit") ??
    fresh.find((n) => alertKind(n) === "failure") ??
    fresh[0];
  return { item: pick, kind: alertKind(pick)!, more: fresh.length - 1 };
}
