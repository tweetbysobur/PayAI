import { NextRequest, NextResponse } from "next/server";
import { rateLimited } from "@/lib/platform/ratelimit";

/**
 * The Plan API — collection (Phase 2C, Stage 3C).
 *
 *   GET  /api/plans            → the signed-in wallet's plans (newest first)
 *   POST /api/plans  {draft}   → validate, plan, pin recipients, store
 *   POST /api/plans  {text}    → the same, from a deterministic text request
 *                                (Stage 5B: lib/plan-intake; 422 when the
 *                                adapter refuses it)
 *
 * Exactly one of draft / text. Create returns { plan, review }: the review is
 * derived on the server from the stored plan, never from the request.
 *
 * Authenticated by the wallet grant cookie only (lib/plan/http.ts); the
 * wallet is never taken from the request. All plan rules live in the Plan
 * Service (lib/plan/service.ts). Responses are never cached.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
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
    const { listPlans } = await import("@/lib/plan/service");
    return planJson({ ok: true, plans: await listPlans(auth) });
  } catch (e) {
    return planErrorResponse(e);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { authenticate, walletLimited, planJson, planErrorResponse, readBody, PlanInputError, noStore, PLAN_IP_LIMIT } = await import("@/lib/plan/http");
  const { createTiming } = await import("@/lib/platform/timing");
  const timing = createTiming("plans.create");
  const done = (res: NextResponse) => timing.finish(res);
  try {
    const ip = await rateLimited(req, "plans-ip", PLAN_IP_LIMIT);
    if (ip) return done(noStore(ip));
    const auth = authenticate(req);
    if (auth instanceof NextResponse) return done(auth);
    const limited = await walletLimited(req, auth, "create");
    if (limited) return done(limited);
    timing.mark("auth");
    const body = await readBody(req);
    const hasDraft = Object.prototype.hasOwnProperty.call(body, "draft");
    const hasText = Object.prototype.hasOwnProperty.call(body, "text");
    if (hasDraft === hasText) throw new PlanInputError("Send exactly one of \"draft\" or \"text\".");
    if (hasText) {
      if (typeof body.text !== "string") throw new PlanInputError("\"text\" must be a string.");
      const { createPlanFromText } = await import("@/lib/plan-intake/intake");
      const r = await createPlanFromText(auth, body.text);
      timing.mark("plan");
      if (!r.ok) return done(planJson({ ok: false, code: r.code, message: r.message }, 422));
      return done(planJson({ ok: true, plan: r.plan, review: r.review }));
    }
    const { createPlan, getPlanWithReview } = await import("@/lib/plan/service");
    const created = await createPlan(auth, body.draft);
    timing.mark("plan");
    return done(planJson({ ok: true, ...(await getPlanWithReview(auth, created.planId)) }));
  } catch (e) {
    return done(planErrorResponse(e));
  }
}
