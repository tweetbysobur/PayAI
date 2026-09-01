import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/tokens — the token-agnostic picker's backend.
 *   ?address=0x...  → resolve any address (native sentinel or ERC-20) to
 *                     real, on-chain-confirmed metadata (symbol/name/decimals).
 *                     This is how "paste a contract address" and "any new
 *                     Monad token" both work with no allowlist gate.
 *   ?q=search        → verified tokens whose name/symbol match the query.
 *   (no params)      → the full verified token list for the active network.
 */
export async function GET(req: NextRequest) {
  // Unauthenticated, and ?address= resolves ARBITRARY caller-supplied
  // addresses — three on-chain reads each, into a cache tokenRegistry keeps
  // PERMANENTLY (correct for immutable metadata, but it means a caller
  // feeding random addresses grows server memory that is never reclaimed as
  // well as spending RPC). The no-params and ?q= paths are cheap; the limit
  // is shared rather than split because the expensive one is the only one
  // worth abusing and a legitimate picker session stays far under it.
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "tokens", { max: 60, windowSec: 60 });
  if (limited) return limited;

  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  const q = url.searchParams.get("q");

  const { resolveToken, getVerifiedTokens, searchTokens } = await import("@/lib/monad/tokenRegistry");

  if (address) {
    try {
      const token = await resolveToken(address);
      return NextResponse.json({ success: true, token });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : "Could not resolve token." }, { status: 422 });
    }
  }

  const verified = await getVerifiedTokens();
  const tokens = q ? searchTokens(verified, q) : verified;
  return NextResponse.json({ success: true, tokens });
}
