import { NextResponse } from "next/server";
import { checkPaymentEngine, getMode } from "@/lib/payment/engine";

/**
 * GET /api/health — public liveness. Booleans and the network name only.
 * No model id, no scheduler counters, no agent wallet, no block height.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const paymentEngine = await checkPaymentEngine();
  const { getChain } = await import("@/lib/monad/config");
  const chain = getChain();

  let wallet: { configured: boolean; network: string; chainId: number } | null = null;
  if (getMode() === "monad") {
    const { isSignerConfigured } = await import("@/lib/monad/wallet");
    wallet = { configured: isSignerConfigured(), network: chain.name, chainId: chain.id };
  }

  const { getHeartbeat, isHeartbeatStale } = await import("@/lib/platform/cronHealth");
  const heartbeat = await getHeartbeat();
  const cronStale = isHeartbeatStale(heartbeat);
  const degraded = (getMode() === "monad" && !paymentEngine.connected) || cronStale;

  const res = NextResponse.json({
    service: "payai",
    status: degraded ? "degraded" : "ok",
    payment: {
      engine: paymentEngine.engine,
      connected: paymentEngine.connected,
    },
    automationScheduler: { status: cronStale ? "stale" : "ok" },
    wallet,
  });
  res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
  return res;
}
