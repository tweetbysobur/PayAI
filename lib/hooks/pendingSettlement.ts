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

export function savePendingSettlement(p: PendingSettlement) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable (private mode, quota) — recovery just won't persist */
  }
}

export function getPendingSettlement(walletAddress?: string | null): PendingSettlement | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingSettlement;
    if (walletAddress && p.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) return null;
    return p;
  } catch {
    return null;
  }
}

export function clearPendingSettlement() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* no-op */
  }
}
