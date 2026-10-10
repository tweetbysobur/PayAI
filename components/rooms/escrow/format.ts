import type { StatusTone } from "@/components/dashboard/primitives";

export type EscrowStatusKey = "pending" | "open" | "completed" | "claimed" | "expired" | "cancelled" | "none";

export const ESCROW_STATUS: Readonly<Record<EscrowStatusKey, { tone: StatusTone; label: string }>> = {
  pending: { tone: "neutral", label: "Not live yet" },
  none: { tone: "danger", label: "Not found on-chain" },
  open: { tone: "pending", label: "Open" },
  completed: { tone: "success", label: "Funded — ready to claim" },
  claimed: { tone: "success", label: "Funds claimed" },
  expired: { tone: "neutral", label: "Expired — refunds open" },
  cancelled: { tone: "neutral", label: "Cancelled — refunds open" },
};

/** "3 days left" / "5 hours left" / "Closed" — from a deadline in ms. */
export function timeLeft(deadlineMs: number, now: number): string {
  const ms = deadlineMs - now;
  if (ms <= 0) return "Closed";
  const h = ms / 3_600_000;
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${Math.floor(h)} hour${Math.floor(h) === 1 ? "" : "s"} left`;
  const m = Math.max(1, Math.floor(ms / 60_000));
  return `${m} minute${m === 1 ? "" : "s"} left`;
}

export const pct = (bps: number) => `${Math.min(100, bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
