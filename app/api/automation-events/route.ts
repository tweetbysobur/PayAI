import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "@/lib/payees/directory";

/**
 * GET /api/automation-events?wallet=0x… — lifecycle notifications for Payment
 * Automations (created, upcoming execution, executed, execution failed,
 * paused, resumed, cancelled). Same wallet-scoping rule as every other read
 * on the shared demo tenant: no wallet resolves to a sentinel that matches
 * nothing, never to "show everyone's automation activity."
 */
export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  const { listAutomationEvents } = await import("@/lib/platform/automationEvents");

  const merchantId = await resolveTenantId(req);
  const w = new URL(req.url).searchParams.get("wallet")?.trim();
  const sender = merchantId === DEMO_TENANT ? (w && isAddress(w) ? w : "__none__") : null;

  const events = await listAutomationEvents(merchantId, { sender, limit: 50 });
  return NextResponse.json({ events });
}
