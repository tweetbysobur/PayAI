/**
 * The connected wallet's transaction history (POST /api/agent, "Show my
 * transaction history"), shared by the surfaces a dashboard sync refreshes
 * together.
 *
 * One sync calls every registered refresher in the same tick, and the bell and
 * the home page both wanted this exact read — two identical reads of the
 * transaction log per cycle. Identical calls made in the SAME tick share one
 * request. The shared entry is dropped on the next tick, so a call from any
 * later moment (the refresh after a payment completes, the next heartbeat)
 * always asks the server again and can never be served stale.
 */
export interface HistoryResponse {
  history?: unknown[];
  [k: string]: unknown;
}

const shared = new Map<string, Promise<HistoryResponse>>();

export function fetchHistory(walletAddress: string | null | undefined): Promise<HistoryResponse> {
  const key = (walletAddress ?? "").toLowerCase();
  const existing = shared.get(key);
  if (existing) return existing;
  const p = fetch("/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: "Show my transaction history", walletAddress: walletAddress ?? null }),
  }).then((r) => r.json() as Promise<HistoryResponse>);
  shared.set(key, p);
  // Same-tick sharing only.
  setTimeout(() => { if (shared.get(key) === p) shared.delete(key); }, 0);
  return p;
}
