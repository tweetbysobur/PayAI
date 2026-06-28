import { NextRequest, NextResponse } from "next/server";

/**
 * GET  /api/schedule        — list the tenant's scheduled payments.
 * DELETE /api/schedule?id=… — cancel an upcoming schedule.
 *
 * Creation goes through /api/agent ("schedule 10 USDC to … every Friday") so it
 * shares the same recipient resolution and guardrails as instant payments.
 */
export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { listSchedules } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const schedules = await listSchedules(merchantId);
  return NextResponse.json({ schedules });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { cancelSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const row = await cancelSchedule(merchantId, id);
  if (!row) return NextResponse.json({ error: "Schedule not found." }, { status: 404 });
  return NextResponse.json({ schedule: row, success: true });
}
