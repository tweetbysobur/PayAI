import { NextRequest, NextResponse } from "next/server";
import { agentConfig } from "@/lib/agent/brain";
import { isAddress, resolvePayee } from "@/lib/payees/directory";
import { isDomainName, extractDomain } from "@/lib/monad/domain-resolver";
import type { ScheduleCadence, ScheduleEndCondition } from "@/lib/platform/types";

/**
 * Legacy compatibility endpoint. New product surfaces should use
 * /api/automations.
 *
 * GET    /api/schedule?wallet=0x…      — list the caller's automations.
 * POST   /api/schedule                 — create one from structured fields.
 * PATCH  /api/schedule?id=…            — edit an automation's terms.
 * DELETE /api/schedule?id=…&wallet=0x… — cancel an automation.
 *
 * On the shared demo tenant (no merchant account), every wallet-only user
 * would otherwise land in the same bucket — so every read/write here is
 * scoped to the caller's own wallet, same as transaction history/analytics. A
 * missing wallet on that tenant resolves to a sentinel that matches nothing,
 * rather than silently falling through to "show/edit/cancel everyone's
 * automations."
 */
async function senderScopeFor(req: NextRequest, merchantId: string, walletFromBody?: string): Promise<string | null> {
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  if (merchantId !== DEMO_TENANT) return null;
  const w = (walletFromBody ?? new URL(req.url).searchParams.get("wallet"))?.trim();
  return w && isAddress(w) ? w : "__none__";
}

const CADENCES: ScheduleCadence[] = ["once", "daily", "weekly", "monthly"];

export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { listSchedules } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId);
  const { denyPrivateRead } = await import("@/lib/auth/walletGrant");
  const denied = await denyPrivateRead(req, sender);
  if (denied) return denied;
  const schedules = await listSchedules(merchantId, { sender });
  return NextResponse.json({ schedules });
}

export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: {
    walletAddress?: string; amount?: number; token?: string; recipient?: string;
    cadence?: string; startAt?: number; memo?: string;
    endCondition?: { type?: string; totalRuns?: number; untilMs?: number };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const walletAddress = body.walletAddress && isAddress(body.walletAddress) ? body.walletAddress : null;
  const amount = Number(body.amount);
  const token = (body.token || "").toUpperCase();
  const recipientInput = (body.recipient || "").trim();
  const cadence = body.cadence as ScheduleCadence;
  const startAt = Number(body.startAt);

  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Enter an amount greater than 0." }, { status: 400 });
  }
  if (token !== "MON" && token !== "USDC") {
    return NextResponse.json({ error: "Choose MON or USDC." }, { status: 400 });
  }
  const cap = token === "MON" ? agentConfig.maxMon : agentConfig.maxUsd;
  if (amount > cap) {
    return NextResponse.json({ error: `Amount exceeds the agent cap of ${cap.toLocaleString()} ${token} per payment.` }, { status: 422 });
  }
  if (!recipientInput) {
    return NextResponse.json({ error: "Enter a recipient — a wallet address or .nad domain." }, { status: 400 });
  }
  if (!CADENCES.includes(cadence)) {
    return NextResponse.json({ error: "Choose how often this should run." }, { status: 400 });
  }
  if (!Number.isFinite(startAt) || startAt <= 0) {
    return NextResponse.json({ error: "Choose when the first payment should run." }, { status: 400 });
  }
  if (startAt < Date.now() - 60_000) {
    return NextResponse.json({ error: "The start time has already passed — choose a time in the future." }, { status: 400 });
  }

  // Resolve the recipient the same way an instant payment does, so an
  // automation can never be created pointing at an unresolved name.
  let recipient = recipientInput;
  let domain: string | null = null;
  if (!isAddress(recipient)) {
    if (isDomainName(recipient)) {
      const { resolveDomain } = await import("@/lib/monad/domain-resolver");
      const dom = extractDomain(recipient) ?? recipient;
      const resolution = await resolveDomain(dom);
      if (!resolution.resolvedAddress) {
        return NextResponse.json({ error: `Couldn't resolve ${dom}. Check the name and try again.` }, { status: 422 });
      }
      domain = resolution.domain;
      recipient = resolution.resolvedAddress;
    } else {
      const payee = resolvePayee(recipient);
      if (!payee) {
        return NextResponse.json({ error: `"${recipient}" isn't a valid address, .nad domain, or known payee.` }, { status: 422 });
      }
      recipient = payee.address;
    }
  }

  // Validate the end condition (defaults to "never", but the UI should always
  // push a bound — a real standing order has one).
  let endCondition: ScheduleEndCondition = { type: "never" };
  const ec = body.endCondition;
  if (ec?.type === "after_count") {
    const totalRuns = Number(ec.totalRuns);
    if (!Number.isFinite(totalRuns) || totalRuns < 1) {
      return NextResponse.json({ error: "Enter how many times this should run." }, { status: 400 });
    }
    endCondition = { type: "after_count", totalRuns: Math.floor(totalRuns) };
  } else if (ec?.type === "until_date") {
    const untilMs = Number(ec.untilMs);
    if (!Number.isFinite(untilMs) || untilMs <= startAt) {
      return NextResponse.json({ error: "The end date must be after the start date." }, { status: 400 });
    }
    endCondition = { type: "until_date", untilMs };
  }

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { createSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const row = await createSchedule(merchantId, {
    amount, token, recipient, domain, cadence, nextRun: startAt,
    memo: body.memo, sender: walletAddress, endCondition,
  });
  return NextResponse.json({ schedule: row, success: true });
}

export async function PATCH(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let body: {
    walletAddress?: string; amount?: number; cadence?: string; nextRun?: number;
    memo?: string; endCondition?: { type?: string; totalRuns?: number; untilMs?: number };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (body.amount != null) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter an amount greater than 0." }, { status: 400 });
    patch.amount = amount;
  }
  if (body.cadence != null) {
    if (!CADENCES.includes(body.cadence as ScheduleCadence)) return NextResponse.json({ error: "Invalid cadence." }, { status: 400 });
    patch.cadence = body.cadence;
  }
  if (body.nextRun != null) {
    const nextRun = Number(body.nextRun);
    if (!Number.isFinite(nextRun) || nextRun < Date.now() - 60_000) {
      return NextResponse.json({ error: "Choose a future time for the next run." }, { status: 400 });
    }
    patch.nextRun = nextRun;
  }
  if (body.memo != null) patch.memo = body.memo;
  if (body.endCondition?.type === "never") patch.endCondition = { type: "never" };
  else if (body.endCondition?.type === "after_count") {
    const totalRuns = Number(body.endCondition.totalRuns);
    if (!Number.isFinite(totalRuns) || totalRuns < 1) return NextResponse.json({ error: "Enter how many times this should run." }, { status: 400 });
    patch.endCondition = { type: "after_count", totalRuns: Math.floor(totalRuns) };
  } else if (body.endCondition?.type === "until_date") {
    const untilMs = Number(body.endCondition.untilMs);
    if (!Number.isFinite(untilMs)) return NextResponse.json({ error: "Invalid end date." }, { status: 400 });
    patch.endCondition = { type: "until_date", untilMs };
  }

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { updateSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId, body.walletAddress);
  const row = await updateSchedule(merchantId, id, patch, { sender });
  if (!row) return NextResponse.json({ error: "Automation not found, not editable, or not yours." }, { status: 404 });
  return NextResponse.json({ schedule: row, success: true });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { cancelSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId);
  const row = await cancelSchedule(merchantId, id, { sender });
  if (!row) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  return NextResponse.json({ schedule: row, success: true });
}
