import { NextRequest, NextResponse } from "next/server";

/**
 * GET  /api/schedule?wallet=0x…        — list the caller's scheduled payments.
 * DELETE /api/schedule?id=…&wallet=0x… — cancel an upcoming schedule.
 *
 * Creation goes through /api/agent ("schedule 10 USDC to … every Friday") so it
 * shares the same recipient resolution and guardrails as instant payments.
 *
 * On the shared demo tenant (no merchant account), every wallet-only user
 * would otherwise land in the same bucket — so reads/cancels there are scoped
 * to the caller's own wallet, same as transaction history/analytics. A missing
 * wallet on that tenant resolves to a sentinel that matches nothing, rather
 * than silently falling through to "show/cancel everyone's schedules."
 */
async function senderScopeFor(req: NextRequest, merchantId: string): Promise<string | null> {
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  const { isAddress } = await import("@/lib/payees/directory");
  if (merchantId !== DEMO_TENANT) return null;
  const w = new URL(req.url).searchParams.get("wallet")?.trim();
  return w && isAddress(w) ? w : "__none__";
}

export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { listSchedules } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId);
  const schedules = await listSchedules(merchantId, { sender });
  return NextResponse.json({ schedules });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { cancelSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId);
  const row = await cancelSchedule(merchantId, id, { sender });
  if (!row) return NextResponse.json({ error: "Schedule not found." }, { status: 404 });
  return NextResponse.json({ schedule: row, success: true });
}
