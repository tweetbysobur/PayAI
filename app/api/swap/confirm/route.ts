import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "@/lib/payees/directory";
import type { WalletEventType } from "@/lib/wallet-service/types";

/** Records a swap outcome in the wallet's notification feed. Best-effort: a
 *  failure to notify must never change what the swap itself reports. */
async function notifySwap(
  req: NextRequest,
  sender: string,
  event: { type: WalletEventType; title: string; detail: string; txHash: string; explorerUrl: string; amount?: number | null; token?: string | null },
): Promise<void> {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { recordWalletEvent } = await import("@/lib/platform/walletEvents");
  await recordWalletEvent({
    merchantId: await resolveTenantId(req),
    sender,
    providerId: "injected",
    ...event,
  });
}

/**
 * POST /api/swap/confirm — after the user signs the swap, verify the
 * transaction actually succeeded on-chain (receipt status === success) before
 * recording it. We never trust the client's word that a swap settled; the
 * on-chain receipt is the source of truth, exactly like the payment path.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "confirm");
  if (limited) return limited;

  let body: {
    walletAddress?: string; txHash?: string; fromToken?: string; toToken?: string; amountIn?: number; amountOut?: number;
    /** "trade" for an Ask PayAI arbitrary-token trade (see
     *  lib/ask/intent/orchestrate.ts's executeTradeIntent), absent/"swap"
     *  for PayAI's existing curated Smart Swap — same settlement endpoint,
     *  just labeled distinctly in the tx log (see PlatformFeature's doc). */
    feature?: "swap" | "trade";
    /** Which DEX actually served the trade — client-reported, same trust
     *  model as fromToken/toToken/amountIn/amountOut below (the on-chain
     *  receipt is still the source of truth for whether it succeeded at
     *  all; this and the amounts are display-only). */
    provider?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { walletAddress, txHash, fromToken, toToken, amountIn, amountOut, provider } = body;
  const feature = body.feature === "trade" ? "trade" : "swap";
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: "A valid txHash is required." }, { status: 400 });
  }
  if (!walletAddress || !isAddress(walletAddress)) {
    return NextResponse.json({ error: "A valid walletAddress is required." }, { status: 400 });
  }

  // The client retries this call until it succeeds (see confirmPending in
  // lib/hooks/useAgentConsole.ts, which documents both confirm endpoints as
  // idempotent on txHash — this one wasn't). Without a claim, every retry
  // appended another "executed swap" row, inflating the user's own history
  // and the merchant's volume for a single on-chain swap.
  const { claimRequest, completeRequest, releaseRequest } = await import("@/lib/platform/idempotency");
  const settleKey = `swap-settle:${txHash.toLowerCase()}`;
  const claim = await claimRequest<Record<string, unknown>>(settleKey);
  if (!claim.claimed) {
    if (claim.status === "done" && claim.result) return NextResponse.json({ ...claim.result, replayed: true });
    return NextResponse.json({ error: "This swap is already being confirmed." }, { status: 409 });
  }

  const { getPublicClient } = await import("@/lib/monad/wallet");
  const { explorerTx } = await import("@/lib/monad/config");
  const pub = getPublicClient();
  let succeeded = false;
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 90_000 });
    // The tx must have been sent BY the declared wallet — otherwise anyone could
    // record a swap under someone else's address, or point at an unrelated
    // successful tx as "proof". (The swapped amounts remain client-reported;
    // decoding exact DEX amounts is pool-specific and out of scope here.)
    if (receipt.from.toLowerCase() !== walletAddress.toLowerCase()) {
      await releaseRequest(settleKey);
      return NextResponse.json({ error: "Transaction was not sent from the declared wallet." }, { status: 409 });
    }
    succeeded = receipt.status === "success";
  } catch {
    // Not confirmable yet — release so the client's retry isn't blocked by
    // its own previous attempt.
    await releaseRequest(settleKey);
    return NextResponse.json({ error: "Couldn't confirm the swap on-chain yet. Check the explorer — it may still settle.", explorerUrl: explorerTx(txHash) }, { status: 502 });
  }

  const explorerUrl = explorerTx(txHash);
  const verb = feature === "trade" ? "Trade" : "Swap";
  const summary = `${verb} ${amountIn ?? "?"} ${fromToken ?? "?"} → ${amountOut != null ? Number(amountOut).toFixed(toToken === "USDC" ? 2 : 4) : "?"} ${toToken ?? "?"}${provider ? ` via ${provider}` : ""}`;

  if (!succeeded) {
    // The receipt was fetched successfully, so this is a DEFINITE, mined revert
    // (not "unknown yet") — the swap failed, gas was spent, but no tokens moved.
    // Safe for the user to try again with a fresh swap. The verdict is final
    // for THIS hash, so it's completed rather than released: a re-ask replays
    // the same answer instead of re-reading the chain.
    const revertBody = { decision: "swap_error", error: `The ${feature} transaction reverted on-chain. No tokens were ${feature === "trade" ? "traded" : "swapped"}. You can safely try again.`, reverted: true, txHash, explorerUrl, success: false };
    // Tell the user, not just the caller: a swap that reverted while they were
    // looking at another page is precisely what the bell is for.
    await notifySwap(req, walletAddress, {
      type: "swap_failed",
      title: `${verb} failed`,
      detail: `${summary} reverted on-chain. No tokens were ${feature === "trade" ? "traded" : "swapped"}.`,
      txHash, explorerUrl,
    }).catch(() => {});
    await completeRequest(settleKey, revertBody);
    return NextResponse.json(revertBody, { status: 502 });
  }

  // Record the swap/trade into the merchant transaction log, same as a payment.
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { recordTx } = await import("@/lib/platform/store");
  const merchantId = await resolveTenantId(req);
  await recordTx(merchantId, {
    decision: "executed",
    action: feature,
    feature,
    amount: amountIn ?? null,
    token: fromToken ?? "MON",
    recipient: walletAddress,
    // A swap/trade is the user's own activity, so it has to carry their
    // address as the sender: every wallet-scoped read filters on it, and
    // without one it never appeared in the history of the person who made it.
    sender: walletAddress,
    riskScore: null,
    compliance: null,
    txHash,
    explorerUrl,
    summary,
    outputAmount: amountOut ?? null,
    outputToken: toToken ?? null,
    provider: provider ?? null,
  });

  await notifySwap(req, walletAddress, {
    type: "swap_completed",
    title: `${verb} completed`,
    detail: summary,
    txHash, explorerUrl,
    amount: amountOut ?? null,
    token: toToken ?? null,
  }).catch(() => {});

  const okBody = { decision: "swap_executed", success: true, txHash, explorerUrl, summary };
  await completeRequest(settleKey, okBody);
  return NextResponse.json(okBody);
}
