import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/analytics — merchant analytics snapshot (scoped to the resolved
 * tenant): revenue overview, 7-day trend, volume, top customers, compliance
 * metrics, AI insights.
 */
export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  // Scope analytics to the connected wallet (sent as a header on GET) so a user's
  // dashboard reflects only their own activity. On the shared demo tenant, no
  // wallet means no data (connect to see yours); a merchant tenant sees its own.
  const { isAddress } = await import("@/lib/payees/directory");
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  const w = req.headers.get("x-wallet-address")?.trim();
  const wallet = w && isAddress(w) ? w : null;
  const sender = merchantId === DEMO_TENANT ? (wallet ?? "__none__") : null;
  const { getAnalytics } = await import("@/lib/platform/analytics");
  return NextResponse.json(await getAnalytics(merchantId, { sender }));
}
