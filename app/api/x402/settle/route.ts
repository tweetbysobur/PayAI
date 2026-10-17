import { NextRequest } from "next/server";

/**
 * POST /api/x402/settle — x402 v2 facilitator settle. Merchant-only: send the
 * PayAI merchant key as x-merchant-key. See lib/x402/http.ts for the rules.
 *
 * The IP limit here is a coarse outer brake that runs before any lookup; the
 * handler adds a tighter per-merchant limit once the key is resolved.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "x402-ip", { max: 300, windowSec: 60 });
  if (limited) return limited;
  const { handleSettle } = await import("@/lib/x402/http");
  return handleSettle(req);
}
