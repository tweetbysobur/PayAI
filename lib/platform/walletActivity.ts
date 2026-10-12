/**
 * A wallet's own PayAI activity, summarised from its transaction log — the
 * same private, wallet-scoped rows the Transactions page lists. Shown on the
 * Wallets page in place of figures that only counted the legacy
 * PaymentExecutor contract (so payments made through Ask never appeared).
 *
 * Only executed (settled) rows count. Amounts stay per token: 5 MON and
 * 5 USDC are never added into one number. Pure; no I/O.
 */
import type { TxLogEntry } from "./types";

export interface WalletActivitySummary {
  /** Executed PayAI transactions of every kind. */
  transactions: number;
  /** Executed transfers: payments, automations, bulk payouts. */
  payments: number;
  /** Executed swaps and trades. */
  swaps: number;
  /** Amount sent in executed transfers over the last 30 days, per token. */
  sent30dByToken: Record<string, number>;
  /** Executed transactions per day, the last 14 days that had any, oldest first. */
  daily: { date: string; count: number }[];
  /** Time of the most recent executed transaction, if any. */
  lastAt: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function kindOf(t: TxLogEntry): "swap" | "payment" | "other" {
  const f = t.feature ?? (/swap|trade/i.test(t.action) ? "swap" : "payment");
  if (f === "swap" || f === "trade") return "swap";
  if (f === "payment" || f === "automation" || f === "bulk") return "payment";
  return "other";
}

export function summarizeWalletActivity(rows: TxLogEntry[], now = Date.now()): WalletActivitySummary {
  const done = rows.filter((t) => t.decision === "executed");
  const sent30dByToken: Record<string, number> = {};
  const perDay = new Map<string, number>();
  let payments = 0;
  let swaps = 0;
  let lastAt: number | null = null;

  for (const t of done) {
    const kind = kindOf(t);
    if (kind === "payment") payments++;
    if (kind === "swap") swaps++;
    if (kind === "payment" && t.amount != null && Number.isFinite(t.amount) && t.amount > 0 && t.at >= now - 30 * DAY_MS) {
      const token = (t.token || "?").toUpperCase();
      sent30dByToken[token] = (sent30dByToken[token] ?? 0) + t.amount;
    }
    if (Number.isFinite(t.at)) {
      const day = new Date(t.at).toISOString().slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      if (lastAt == null || t.at > lastAt) lastAt = t.at;
    }
  }

  const daily = [...perDay.keys()].sort().slice(-14).map((date) => ({ date, count: perDay.get(date)! }));
  return { transactions: done.length, payments, swaps, sent30dByToken, daily, lastAt };
}
