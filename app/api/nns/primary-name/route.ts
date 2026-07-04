import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "@/lib/payees/directory";

/**
 * GET /api/nns/primary-name?address=0x… — reverse-resolve an address to its
 * primary .nad name (or null). Read-only; used by the dashboard wallet summary.
 */
export async function GET(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "read");
  if (limited) return limited;

  const address = new URL(req.url).searchParams.get("address");
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "A valid address is required." }, { status: 400 });
  }
  const { reverseResolve } = await import("@/lib/monad/reverse-resolver");
  const name = await reverseResolve(address as `0x${string}`);
  return NextResponse.json({ address, name });
}
