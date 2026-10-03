import { NextRequest, NextResponse } from "next/server";
import { rateLimited } from "@/lib/platform/ratelimit";

/**
 * The Plan API — collection (Phase 2C, Stage 3C).
 *
 *   GET  /api/plans            → the signed-in wallet's plans (newest first)
 *   POST /api/plans  {draft}   → validate, plan, pin recipients, store
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
  try {
    const ip = await rateLimited(req, "plans-ip", PLAN_IP_LIMIT);
    if (ip) return noStore(ip);
    const auth = authenticate(req);
    if (auth instanceof NextResponse) return auth;
    const limited = await walletLimited(req, auth, "create");
    if (limited) return limited;
    const body = await readBody(req);
    if (!Object.prototype.hasOwnProperty.call(body, "draft")) throw new PlanInputError("\"draft\" is required.");
    const { createPlan } = await import("@/lib/plan/service");
    return planJson({ ok: true, plan: await createPlan(auth, body.draft) });
  } catch (e) {
    return planErrorResponse(e);
  }
}
