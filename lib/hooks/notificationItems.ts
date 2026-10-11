/**
 * How an activity becomes a bell notification: what it is called, where it
 * opens, and that one transaction is one notification.
 *
 * Pure; no imports.
 */

interface HistoryLike {
  decision: string;
  feature?: string | null;
  action?: string | null;
  summary?: string | null;
}

const isSwap = (h: HistoryLike) => h.feature === "trade" || h.feature === "swap" || h.action === "swap";

/** The notification title for a transaction-log row, or null when that kind
 *  of row isn't a notification. A swap is never called a payment, and a
 *  protocol action (wrap, Aave) is named by its own verified summary. */
export function historyTitle(h: HistoryLike): string | null {
  if (h.feature === "protocol") {
    if (h.decision === "executed") return h.summary?.trim() || "Transaction completed";
    if (h.decision === "error") return "Transaction failed";
    return null;
  }
  if (isSwap(h)) {
    if (h.decision === "executed") return "Swap completed";
    if (h.decision === "error") return "Swap failed";
  }
  switch (h.decision) {
    case "executed": return "Payment sent";
    case "needs_review": return "Payment stopped — nothing was sent";
    case "blocked": return "Payment blocked";
    case "refused": return "Payment refused";
    case "error": return "Payment failed";
    default: return null;
  }
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** History's Activity view, opened on exactly this transaction — the one feed
 *  that shows payments, swaps, automation runs, deposits and withdrawals. */
export function txHref(txHash: string | null | undefined): string | null {
  return txHash && HASH_RE.test(txHash) ? `/dashboard/transactions?tab=activity&tx=${txHash}` : null;
}

/** One notification per transaction: the first item seen for a hash wins
 *  (pass the most specific source first). Items without a hash are kept. */
export function dedupeByTx<T extends { txHash?: string | null }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const h = i.txHash?.toLowerCase();
    if (!h) return true;
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}
