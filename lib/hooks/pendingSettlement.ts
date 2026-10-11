"use client";

/**
 * Survives the highest-consequence gap in the wallet-signed payment/swap flow:
 * the wallet can broadcast a transaction (real funds move) and then the
 * confirm step can fail for reasons that have nothing to do with the payment
 * itself — an RPC hiccup, a network blip, or the user closing/refreshing the
 * tab before /api/agent/confirm returns. Without this, the app would tell the
 * user "payment failed" when it actually succeeded, risking a real double-pay
 * on retry and an on-chain payment that never appears in their history.
 *
 * The moment a wallet signature produces a txHash, callers persist a record
 * here (localStorage survives a refresh; sessionStorage would not). On next
 * load, useAgentConsole checks for a pending record for the connected wallet
 * and resumes confirmation automatically — the user never has to notice.
 */

export interface PendingSettlement {
  kind: "payment" | "swap";
  walletAddress: string;
  txHash: string;
  // payment
  rawText?: string;
  requestId?: string;
  // swap
  fromToken?: string;
  toToken?: string;
  amountIn?: number;
  amountOut?: number;
  savedAt: number;
}

const KEY = "payai_pending_settlement";
/** Records beyond the primary one, oldest first. Kept apart from KEY so the
 *  primary stays a single record object, exactly as older code wrote it. */
const QUEUE_KEY = "payai_pending_settlement_queue";

const sameHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function readOne(key: string): PendingSettlement | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingSettlement;
    return p && typeof p.txHash === "string" && typeof p.walletAddress === "string" ? p : null;
  } catch {
    return null;
  }
}

function readQueue(): PendingSettlement[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list as PendingSettlement[]).filter((p) => p && typeof p.txHash === "string" && typeof p.walletAddress === "string") : [];
  } catch {
    return [];
  }
}

function writeQueue(list: PendingSettlement[]) {
  try {
    if (list.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — see savePendingSettlement */
  }
}

/** Every pending record, primary first, then the rest oldest first. */
function readAll(): PendingSettlement[] {
  const primary = readOne(KEY);
  return primary ? [primary, ...readQueue()] : readQueue();
}

function writeAll(list: PendingSettlement[]) {
  try {
    const [first, ...rest] = list;
    if (first) localStorage.setItem(KEY, JSON.stringify(first));
    else localStorage.removeItem(KEY);
    writeQueue(rest);
  } catch {
    /* storage unavailable — recovery just won't persist */
  }
}

/** Records one broadcast transaction. A different transaction's record is
 *  never replaced; the same hash saved again replaces only its own record. */
export function savePendingSettlement(p: PendingSettlement) {
  const all = readAll();
  const at = all.findIndex((x) => sameHash(x.txHash, p.txHash));
  if (at >= 0) all[at] = p;
  else all.push(p);
  writeAll(all);
}

/** The oldest pending record (for `walletAddress`, when given). Recovery works
 *  through them in order: clearing one brings the next into view. */
export function getPendingSettlement(walletAddress?: string | null): PendingSettlement | null {
  for (const p of readAll()) {
    if (!walletAddress || p.walletAddress.toLowerCase() === walletAddress.toLowerCase()) return p;
  }
  return null;
}

/** Removes the record for `txHash` and nothing else. Without a hash it removes
 *  the primary record (the old single-record behaviour) — callers that know
 *  their transaction should always pass it. */
export function clearPendingSettlement(txHash?: string) {
  const all = readAll();
  if (txHash) writeAll(all.filter((x) => !sameHash(x.txHash, txHash)));
  else writeAll(all.slice(1));
}
