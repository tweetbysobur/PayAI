import { NextRequest, NextResponse } from "next/server";
import { partnerBuild, validateRequest } from "@/lib/partner/swap";
import { partnerError, partnerGate } from "../shared";

/**
 * POST /api/partner/swap/build — the unsigned MON → token swap for a
 * partner's user. Body: { token, amountMon, slippageBps?, wallet }.
 * Re-quotes fresh; `wallet` is the only recipient. Returns one call
 * ({ to, data, value }) for the user to sign in the partner's app. PayAI
 * never signs, sends or holds anything here.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "partner-ip", { max: 120 });
  if (limited) return limited;
  const gate = await partnerGate(req);
  if (gate instanceof NextResponse) return gate;
  try {
    const body = await req.json().catch(() => null);
    const wallet = body && typeof body === "object" && typeof body.wallet === "string" ? body.wallet.trim() : "";
    return NextResponse.json(await partnerBuild(validateRequest(gate, body), wallet));
  } catch (e) {
    return partnerError(e, "build");
  }
}
