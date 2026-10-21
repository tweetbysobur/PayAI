import { NextRequest, NextResponse } from "next/server";
import { partnerQuote, validateRequest } from "@/lib/partner/swap";
import { partnerError, partnerGate } from "../shared";

/**
 * POST /api/partner/swap/quote — read-only MON → token quote for a partner
 * app, server to server. Body: { token, amountMon, slippageBps? }.
 * Authorization: Bearer <partner key>. See lib/partner/auth.ts.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "partner-ip", { max: 120 });
  if (limited) return limited;
  const gate = await partnerGate(req);
  if (gate instanceof NextResponse) return gate;
  try {
    return NextResponse.json(await partnerQuote(validateRequest(gate, await req.json().catch(() => null))));
  } catch (e) {
    return partnerError(e, "quote");
  }
}
