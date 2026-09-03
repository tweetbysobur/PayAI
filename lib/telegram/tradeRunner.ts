/**
 * Signs and sends a trade for /buy and /sell — the one place a Telegram
 * user's custodial key actually gets used to move funds on a trade.
 *
 * Deliberately thin: all quoting, slippage/price-impact enforcement, and
 * unsigned-plan building already happen in lib/monad/tradeQuote.ts's
 * previewTrade()/prepareTradeExecution(), which are signer-agnostic — the
 * browser-signed Ask PayAI flow (lib/ask/intent/orchestrate.ts) drives the
 * identical `steps` array against an abstract sendTransaction/waitForReceipt
 * pair. This file is that same shape, with a per-Telegram-user viem
 * WalletClient standing in for the browser wallet.
 *
 * Settlement (recording the trade, notifying, idempotency) is NOT
 * reimplemented here — after each settleable step confirms on-chain, this
 * calls the app's own /api/swap/confirm route exactly the way the browser
 * client does, so there is still only one settlement code path in the app.
 *
 * Server-only.
 */
import "server-only";
import { createWalletClient, type Address, type PrivateKeyAccount } from "viem";
import { getChain, getTransport, explorerTx } from "@/lib/monad/config";
import { getPublicClient } from "@/lib/monad/wallet";
import { prepareTradeExecution, type TradePreviewRequest } from "@/lib/monad/tradeQuote";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export type TradeRunResult =
  | { ok: true; txHash: string; explorerUrl: string; spend: { amount: string; token: string }; receive: { amount: string; token: string }; provider: string }
  | { ok: false; message: string };

function publicBaseUrl(): string {
  return process.env.VERIPAYAI_PUBLIC_URL || "https://veripayai.vercel.app";
}

/** Server-to-server call to the app's OWN settlement route — see this
 *  file's own doc for why this isn't reimplemented locally. Best-effort in
 *  the sense that a settlement hiccup must never be reported as the trade
 *  itself having failed (real funds already moved on-chain by this point;
 *  that's a fact independent of whether the history/notification call
 *  succeeds), but it's not silent either — logged so a missing history
 *  entry is diagnosable rather than mysterious. */
async function settleTrade(input: {
  txHash: string; walletAddress: string; fromToken: string; toToken: string; amountIn: number; amountOut: number; provider: string;
}): Promise<void> {
  try {
    const res = await fetch(`${publicBaseUrl()}/api/swap/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: input.walletAddress,
        txHash: input.txHash,
        fromToken: input.fromToken,
        toToken: input.toToken,
        amountIn: input.amountIn,
        amountOut: input.amountOut,
        feature: "trade",
        provider: input.provider,
        ...(ADDRESS_RE.test(input.toToken) ? { outputTokenAddress: input.toToken } : {}),
      }),
    });
    if (!res.ok) console.error(`[telegram] /api/swap/confirm settle failed (${res.status}) for ${input.txHash}`);
  } catch (e) {
    console.error(`[telegram] /api/swap/confirm settle threw for ${input.txHash}:`, e);
  }
}

/**
 * Previews, builds, signs, broadcasts, and settles one trade end to end.
 * `req.walletAddress` is overwritten with the account's own address —
 * a Telegram trade only ever spends from the wallet the command's own
 * caller owns, never a wallet address supplied in the command text.
 */
export async function runTrade(account: PrivateKeyAccount, req: Omit<TradePreviewRequest, "walletAddress">): Promise<TradeRunResult> {
  const full: TradePreviewRequest = { ...req, walletAddress: account.address };

  // prepareTradeExecution() calls previewTrade() internally and returns its
  // result either way (TradePreviewErr on an outright failure, or `preview`
  // alongside `steps`/`status` on success) — no need to call previewTrade()
  // a second time here.
  const build = await prepareTradeExecution(full, null);
  if (!build.ok) return { ok: false, message: build.message };
  if (build.status === "changed") {
    return { ok: false, message: "The quote moved right before I could execute it — try the trade again." };
  }
  const preview = build.preview;

  const chain = getChain();
  const wallet = createWalletClient({ account, chain, transport: getTransport() });
  const pub = getPublicClient();

  let lastHash: `0x${string}` | null = null;
  for (const step of build.steps) {
    try {
      lastHash = await wallet.sendTransaction({
        account, chain,
        to: step.tx.to as Address,
        data: step.tx.data as `0x${string}`,
        value: step.tx.value ? BigInt(step.tx.value) : 0n,
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : `The ${step.kind} step failed to broadcast.` };
    }

    let confirmed = false;
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash: lastHash, timeout: 90_000 });
      confirmed = receipt.status === "success";
    } catch {
      // Broadcast succeeded but confirmation timed out — real gas was spent
      // and the tx may still land, so this is reported honestly as
      // unconfirmed-with-a-real-hash, never as an outright failure.
      return { ok: false, message: `Submitted, but I couldn't confirm it in time. Check ${explorerTx(lastHash)} — it may still settle.` };
    }
    if (!confirmed) {
      return { ok: false, message: `The ${step.kind} step reverted on-chain. No funds moved on this step. ${explorerTx(lastHash)}` };
    }

    if (step.settleLeg) {
      await settleTrade({
        txHash: lastHash, walletAddress: account.address,
        fromToken: step.settleLeg.fromToken, toToken: step.settleLeg.toToken,
        amountIn: step.settleLeg.amountIn, amountOut: step.settleLeg.amountOut,
        provider: step.settleLeg.provider,
      });
    }
  }

  if (!lastHash) return { ok: false, message: "Nothing was actually submitted for this trade." };
  return {
    ok: true, txHash: lastHash, explorerUrl: explorerTx(lastHash),
    spend: preview.spend, receive: preview.receive, provider: preview.route.provider,
  };
}
