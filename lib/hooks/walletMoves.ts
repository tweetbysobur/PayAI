/**
 * Money that moved in or out of the wallet without PayAI executing it —
 * deposits, and sends made from another app — as rows for the history lists.
 *
 * PayAI's transaction log only holds what PayAI executed, so a deposit was
 * only ever in the notification feed and never in History. These come from
 * the same server-side reconciler that raises the deposit notification
 * (/api/wallet-events, lib/wallet-service/reconcile.ts): real, verified
 * on-chain movement, nothing a client can post.
 */
export interface WalletMoveRow {
  at: number;
  /** "received" for a deposit, "sent_out" for a send PayAI didn't make. */
  decision: "received" | "sent_out";
  direction: "in" | "out";
  summary: string;
  amount: number | null;
  token: string;
  txHash?: string;
  explorerUrl?: string;
}

interface WalletEventRow {
  type: string;
  at: number;
  detail: string;
  amount?: number | null;
  token?: string | null;
  txHash?: string;
  explorerUrl?: string;
}

export function toWalletMoves(events: WalletEventRow[]): WalletMoveRow[] {
  const rows: WalletMoveRow[] = [];
  for (const e of events) {
    if (e.type !== "deposit_received" && e.type !== "withdrawal_completed") continue;
    const inbound = e.type === "deposit_received";
    rows.push({
      at: e.at,
      decision: inbound ? "received" : "sent_out",
      direction: inbound ? "in" : "out",
      summary: e.detail,
      amount: e.amount ?? null,
      token: e.token ?? "",
      // Contract-originated deposits carry a block-range marker, not a hash.
      txHash: e.txHash && !e.txHash.startsWith("internal:") ? e.txHash : undefined,
      explorerUrl: e.explorerUrl,
    });
  }
  return rows;
}

export function fetchWalletMoves(walletAddress: string | null | undefined, providerId?: string | null): Promise<WalletMoveRow[]> {
  if (!walletAddress) return Promise.resolve([]);
  return fetch(`/api/wallet-events?wallet=${walletAddress}${providerId ? `&provider=${providerId}` : ""}`)
    .then((r) => r.json())
    .then((j) => toWalletMoves((j.events ?? []) as WalletEventRow[]))
    .catch(() => []);
}

/** Newest first; one row per transaction (a PayAI row wins over a move). */
export function mergeByTime<T extends { at: number; txHash?: string }>(payai: T[], moves: T[]): T[] {
  const seen = new Set(payai.map((r) => r.txHash?.toLowerCase()).filter(Boolean));
  return [...payai, ...moves.filter((m) => !m.txHash || !seen.has(m.txHash.toLowerCase()))].sort((a, b) => b.at - a.at);
}
