import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "@/lib/payees/directory";

/**
 * POST /api/swap/confirm — after the user signs the swap, verify the
 * transaction actually succeeded on-chain (receipt status === success) before
 * recording it. We never trust the client's word that a swap settled; the
 * on-chain receipt is the source of truth, exactly like the payment path.
 */
export async function POST(req: NextRequest) {
  let body: { walletAddress?: string; txHash?: string; fromToken?: string; toToken?: string; amountIn?: number; amountOut?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { walletAddress, txHash, fromToken, toToken, amountIn, amountOut } = body;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: "A valid txHash is required." }, { status: 400 });
  }
  if (!walletAddress || !isAddress(walletAddress)) {
    return NextResponse.json({ error: "A valid walletAddress is required." }, { status: 400 });
  }

  const { getPublicClient } = await import("@/lib/monad/wallet");
  const { explorerTx } = await import("@/lib/monad/config");
  const pub = getPublicClient();
  let succeeded = false;
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 90_000 });
    succeeded = receipt.status === "success";
  } catch {
    return NextResponse.json({ error: "Couldn't confirm the swap on-chain yet. Check the explorer — it may still settle.", explorerUrl: explorerTx(txHash) }, { status: 502 });
  }

  const explorerUrl = explorerTx(txHash);
  const summary = `Swap ${amountIn ?? "?"} ${fromToken ?? "?"} → ${amountOut != null ? Number(amountOut).toFixed(toToken === "USDC" ? 2 : 4) : "?"} ${toToken ?? "?"}`;

  if (!succeeded) {
    return NextResponse.json({ decision: "swap_error", error: "The swap transaction reverted on-chain.", txHash, explorerUrl, success: false }, { status: 502 });
  }

  // Record the swap into the merchant transaction log, same as a payment.
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { recordTx } = await import("@/lib/platform/store");
  const merchantId = await resolveTenantId(req);
  await recordTx(merchantId, {
    decision: "executed",
    action: "swap",
    amount: amountIn ?? null,
    token: fromToken ?? "MON",
    recipient: walletAddress,
    riskScore: null,
    compliance: null,
    txHash,
    explorerUrl,
    summary,
  });

  return NextResponse.json({ decision: "swap_executed", success: true, txHash, explorerUrl, summary });
}
