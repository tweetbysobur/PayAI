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
    /** The received token's real contract address, when the trade named it
     *  by address rather than a curated symbol — see TxLogEntry's
     *  outputTokenAddress. Validated as an address below and dropped if it
     *  isn't one; display/discovery metadata only, never used for
     *  settlement, amounts, or any on-chain decision. */
    outputTokenAddress?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { walletAddress, txHash, fromToken, toToken, amountIn, amountOut, provider } = body;
  const feature = body.feature === "trade" ? "trade" : "swap";
  // Only ever stored when it really is an address — a symbol here would be
  // useless to the portfolio (which reads balanceOf by contract) and would
  // quietly reintroduce the bare-symbol confusion this field exists to end.
  const outputTokenAddress =
    typeof body.outputTokenAddress === "string" && isAddress(body.outputTokenAddress)
      ? body.outputTokenAddress
      : null;
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
  // Confirm from the event: for a trade that routed through PayAITradeExecutor,
  // decode TradeExecuted from the receipt and report the REAL delivered output
  // and fee, rather than the pre-trade estimate the client sent. Best-effort —
  // any hiccup falls back to the client-reported amount, like the rest of this
  // route (the receipt's success status remains the source of truth).
  let effAmountOut: number | null = amountOut ?? null;
  let feePaid: number | null = null;
  let viaExecutor = false;
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 90_000 });
    // The tx must have been sent BY the declared wallet — otherwise anyone could
    // record a swap under someone else's address, or point at an unrelated
    // successful tx as "proof".
    if (receipt.from.toLowerCase() !== walletAddress.toLowerCase()) {
      await releaseRequest(settleKey);
      return NextResponse.json({ error: "Transaction was not sent from the declared wallet." }, { status: 409 });
    }
    succeeded = receipt.status === "success";
    if (succeeded && feature === "trade") {
      try {
        const { decodeTradeExecuted } = await import("@/lib/monad/tradeExecutor");
        const ev = decodeTradeExecuted(receipt.logs);
        if (ev) {
          const { formatUnits } = await import("viem");
          const DEC_ABI = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
          const ZERO = "0x0000000000000000000000000000000000000000";
          const decOf = async (t: string): Promise<number> =>
            t.toLowerCase() === ZERO ? 18 : Number(await pub.readContract({ address: t as `0x${string}`, abi: DEC_ABI, functionName: "decimals" }).catch(() => 18));
          effAmountOut = Number(formatUnits(ev.amountOut, await decOf(ev.tokenOut)));
          feePaid = Number(formatUnits(ev.feeAmount, await decOf(ev.tokenIn)));
          viaExecutor = true;
        }
      } catch { /* fall back to the client-reported amount */ }
    }
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

  // Prefer the event-confirmed output (and disclose the PayAI fee) when the
  // trade routed through the executor; otherwise the client-reported numbers.
  const successSummary =
    `${verb} ${amountIn ?? "?"} ${fromToken ?? "?"} → ${effAmountOut != null ? Number(effAmountOut).toFixed(toToken === "USDC" ? 2 : 4) : "?"} ${toToken ?? "?"}` +
    `${provider ? ` via ${provider}` : ""}${viaExecutor && feePaid != null ? ` (PayAI fee ${feePaid} ${fromToken ?? ""})` : ""}`;

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
    summary: successSummary,
    outputAmount: effAmountOut,
    outputToken: toToken ?? null,
    outputTokenAddress,
    provider: provider ?? null,
  });

  await notifySwap(req, walletAddress, {
    type: "swap_completed",
    title: `${verb} completed`,
    detail: successSummary,
    txHash, explorerUrl,
    amount: effAmountOut,
    token: toToken ?? null,
  }).catch(() => {});

  const okBody = { decision: "swap_executed", success: true, txHash, explorerUrl, summary: successSummary, amountOut: effAmountOut, fee: feePaid, viaExecutor };
  await completeRequest(settleKey, okBody);
  return NextResponse.json(okBody);
}
