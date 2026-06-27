import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/analytics — merchant analytics snapshot (scoped to the resolved
 * tenant): revenue overview, 7-day trend, volume, top customers, compliance
 * metrics, AI insights.
 */
export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const { getAnalytics } = await import("@/lib/platform/analytics");
  return NextResponse.json(await getAnalytics(merchantId));
}
