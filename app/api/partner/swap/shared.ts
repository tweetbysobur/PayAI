import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { partnerForKey, type Partner } from "@/lib/partner/auth";
import { PartnerSwapError } from "@/lib/partner/swap";

/**
 * Shared gate for /api/partner/swap/*, run after each route's own per-IP
 * limit (which throttles key guessing): checks the partner key, then applies
 * the partner's own limit. Returns the partner, or the response to send.
 */
export async function partnerGate(req: NextRequest): Promise<Partner | NextResponse> {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const partner = partnerForKey(req.headers.get("authorization"));
  if (!partner) return NextResponse.json({ ok: false, message: "Unknown partner key." }, { status: 401 });

  const partnerLimited = await rateLimited(req, "partner", { max: 300, subject: partner.id });
  if (partnerLimited) return partnerLimited;
  return partner;
}

export function partnerError(e: unknown, route: string): NextResponse {
  if (e instanceof PartnerSwapError) return NextResponse.json({ ok: false, message: e.message }, { status: e.status });
  console.error(`[partner] ${route} failed`, e);
  return NextResponse.json({ ok: false, message: "Couldn't reach Monad to prepare that swap. Try again in a moment." }, { status: 502 });
}
