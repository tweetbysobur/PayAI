import { NextRequest, NextResponse } from "next/server";

const ADDR = /^0x[a-fA-F0-9]{40}$/;

/**
 * GET /api/wallet-intelligence?address=0x... — real on-chain data for the
 * connected wallet (balances, payment history via PaymentExecutor logs, gas
 * spent, USD value). Returns 400 for a missing/invalid address, 200 with
 * configured:false when the PaymentExecutor isn't deployed on this network.
 */
export async function GET(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "read");
  if (limited) return limited;

  const address = req.nextUrl.searchParams.get("address") || "";
  if (!ADDR.test(address)) {
    return NextResponse.json({ ok: false, error: "A valid 0x wallet address is required." }, { status: 400 });
  }
  try {
    const { executorEnabled } = await import("@/lib/monad/contracts");
    const { getWalletIntelligence } = await import("@/lib/monad/wallet-intel");
    if (!executorEnabled()) {
      return NextResponse.json({ ok: true, configured: false });
    }
    // An overall budget: a slow or rate-limited RPC used to hold this request
    // until the platform killed it at 300 s, leaving the page spinning.
    const { withTimeout } = await import("@/lib/monad/rpcTimeout");
    const data = await withTimeout(getWalletIntelligence(address as `0x${string}`), 25_000, null);
    if (!data) {
      return NextResponse.json(
        { ok: false, error: "The network is slow to answer right now. Try again in a moment." },
        { status: 504 },
      );
    }
    return NextResponse.json({ ok: true, configured: true, ...data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Could not load wallet data from the network." },
      { status: 502 },
    );
  }
}
