import { NextRequest } from "next/server";

/**
 * GET /api/x402/supported — the x402 v2 kinds, extensions and signer
 * addresses PayAI's facilitator relays. Public. See lib/x402/http.ts.
 */
export async function GET(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "x402-supported", { max: 60, windowSec: 60 });
  if (limited) return limited;
  const { handleSupported } = await import("@/lib/x402/http");
  return handleSupported();
}
