import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/prices?tokens=<addr>:<decimals>,<addr>:<decimals>,...
 *
 * Approximate USD unit prices, derived from the same Uniswap deployment the
 * swap engine routes through. Returns a map keyed by lowercased address, with
 * null for anything that has no pool — callers must render null as
 * "unavailable", never as 0.
 *
 * A missing/unpriceable token is NOT an error: the response stays 200 with
 * nulls, because a dashboard shouldn't break because one exotic token has no
 * liquidity.
 */
export async function GET(req: NextRequest) {
  // Unauthenticated and RPC-amplifying: the 25-token cap below bounds ONE
  // request, but each token costs two probes across three fee tiers, so a
  // request of 25 addresses nobody has priced before is up to 150 quoter
  // calls — and prices.ts's 60s cache is no defense at all against a caller
  // supplying fresh random addresses every time, since none of them hit it.
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "prices", { max: 60, windowSec: 60 });
  if (limited) return limited;

  const raw = new URL(req.url).searchParams.get("tokens") ?? "";
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25) // bound the work per request
    .map((pair) => {
      const [address, decimals] = pair.split(":");
      return { address: (address ?? "").trim(), decimals: Number(decimals) };
    })
    .filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address) && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 30);

  if (tokens.length === 0) return NextResponse.json({ success: true, prices: {}, quotedIn: "USDC" });

  try {
    const { getUsdPrices } = await import("@/lib/monad/prices");
    const prices = await getUsdPrices(tokens);
    return NextResponse.json({ success: true, prices, quotedIn: "USDC", approximate: true });
  } catch {
    // Never fail the caller — an absent price just hides the USD line.
    return NextResponse.json({ success: true, prices: {}, quotedIn: "USDC", approximate: true });
  }
}
