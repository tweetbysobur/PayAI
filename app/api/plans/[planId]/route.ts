import { NextRequest, NextResponse } from "next/server";
import { rateLimited } from "@/lib/platform/ratelimit";

/**
 * The Plan API — one plan (Phase 2C, Stage 3C).
 *
 *   GET  /api/plans/:planId                                  → the plan view + its server-derived review
 *   POST /api/plans/:planId  { op: "approve" }               → approve
 *                            { op: "abandon" }               → abandon
 *                            { op: "next" }                  → the current step
 *                            { op: "quote",  nodeId }        → quote the step (returns the one-time token)
 *                            { op: "bind",   nodeId, quoteToken }
 *                            { op: "tx",     nodeId, quoteId, txHash }
 *                            { op: "settle", nodeId }        → 202 while the confirmation is pending
 *                            { op: "intent",  nodeId, quoteId }          → record the signing intent
 *                            { op: "release", nodeId, quoteId, reason }  → release that signing attempt
 *
 * Authenticated by the wallet grant cookie only (lib/plan/http.ts). The
 * route only dispatches: every plan rule — ownership, approval, expiry,
 * abandonment, current step, quote attempts and freshness, build records,
 * settlement — is the Plan Service's (lib/plan/service.ts). Nothing here
 * accepts a status, outputs or a wallet. Responses are never cached.
 *
 * intent / release (Stage 5C-2d) accept EXACTLY the fields listed: no
 * wallet, transaction hash, status, build data, calldata, target, token,
 * amount, fee or chain. A release reason is wallet_rejected or
 * user_attested_not_sent.
 */
type Ctx = { params: Promise<{ planId: string }> };

const OPS = {
  approve: "manage", abandon: "manage", next: "read", quote: "quote", bind: "bind", tx: "tx", settle: "settle",
  intent: "tx", release: "tx",
} as const;

/** The only fields intent / release bodies may carry. */
const EXACT_FIELDS: Partial<Record<keyof typeof OPS, readonly string[]>> = {
  intent: ["op", "nodeId", "quoteId"],
  release: ["op", "nodeId", "quoteId", "reason"],
};
const RELEASE_REASONS = ["wallet_rejected", "user_attested_not_sent"];

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { authenticate, walletLimited, planJson, planErrorResponse, noStore, PLAN_IP_LIMIT } = await import("@/lib/plan/http");
  // One error boundary for the whole request: a limiter or grant failure is
  // a generic 502 (no-store) like any other unexpected error.
  try {
    const ip = await rateLimited(req, "plans-ip", PLAN_IP_LIMIT);
    if (ip) return noStore(ip);
    const auth = authenticate(req);
    if (auth instanceof NextResponse) return auth;
    const limited = await walletLimited(req, auth, "read");
    if (limited) return limited;
    const { planId } = await params;
    const { getPlanWithReview } = await import("@/lib/plan/service");
    return planJson({ ok: true, ...(await getPlanWithReview(auth, planId)) });
  } catch (e) {
    return planErrorResponse(e);
  }
}

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const { authenticate, walletLimited, planJson, planErrorResponse, readBody, stringField, PlanInputError, noStore, PLAN_IP_LIMIT } = await import("@/lib/plan/http");
  try {
    const ip = await rateLimited(req, "plans-ip", PLAN_IP_LIMIT);
    if (ip) return noStore(ip);
    const auth = authenticate(req);
    if (auth instanceof NextResponse) return auth;
    const body = await readBody(req);
    const op = body.op;
    if (typeof op !== "string" || !Object.prototype.hasOwnProperty.call(OPS, op)) throw new PlanInputError("Unknown operation.");
    const exact = EXACT_FIELDS[op as keyof typeof OPS];
    if (exact && Object.keys(body).some((k) => !exact.includes(k))) throw new PlanInputError("Unexpected field.");
    const limited = await walletLimited(req, auth, OPS[op as keyof typeof OPS]);
    if (limited) return limited;

    const { planId } = await params;
    const svc = await import("@/lib/plan/service");
    switch (op as keyof typeof OPS) {
      case "approve":
        return planJson({ ok: true, plan: await svc.approvePlan(auth, planId) });
      case "abandon":
        return planJson({ ok: true, plan: await svc.abandonPlan(auth, planId) });
      case "next":
        return planJson({ ok: true, next: await svc.nextStep(auth, planId) });
      case "quote":
        return planJson({ ok: true, quote: await svc.quoteStep(auth, planId, stringField(body, "nodeId", 64)) });
      case "bind":
        return planJson({ ok: true, bound: await svc.bindQuote(auth, planId, stringField(body, "nodeId", 64), stringField(body, "quoteToken", 4096)) });
      case "tx":
        return planJson({ ok: true, plan: await svc.recordTx(auth, planId, stringField(body, "nodeId", 64), {
          quoteId: stringField(body, "quoteId", 128), txHash: stringField(body, "txHash", 128),
        }) });
      case "settle":
        return planJson({ ok: true, plan: await svc.settleStep(auth, planId, stringField(body, "nodeId", 64)) });
      case "intent":
        return planJson({ ok: true, plan: await svc.recordSigningIntent(auth, planId, stringField(body, "nodeId", 64), {
          quoteId: stringField(body, "quoteId", 128),
        }) });
      case "release": {
        const reason = stringField(body, "reason", 64);
        if (!RELEASE_REASONS.includes(reason)) throw new PlanInputError("Invalid release reason.");
        return planJson({ ok: true, plan: await svc.releaseAttempt(auth, planId, stringField(body, "nodeId", 64), {
          quoteId: stringField(body, "quoteId", 128), reason,
        }) });
      }
    }
    throw new PlanInputError("Unknown operation.");
  } catch (e) {
    return planErrorResponse(e);
  }
}
