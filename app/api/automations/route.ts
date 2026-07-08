import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { agentConfig } from "@/lib/agent/brain";
import { isAddress, resolvePayee } from "@/lib/payees/directory";
import { isDomainName, extractDomain } from "@/lib/monad/domain-resolver";
import type { AutomationIntervalUnit, ScheduleCadence, ScheduleEndCondition } from "@/lib/platform/types";

const CADENCES: ScheduleCadence[] = ["once", "daily", "weekly", "monthly", "custom"];
const INTERVAL_UNITS: AutomationIntervalUnit[] = ["days", "weeks", "months"];

async function senderScopeFor(req: NextRequest, merchantId: string, walletFromBody?: string): Promise<string | null> {
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  if (merchantId !== DEMO_TENANT) return null;
  const w = (walletFromBody ?? new URL(req.url).searchParams.get("wallet"))?.trim();
  return w && isAddress(w) ? w : "__none__";
}

async function resolveRecipient(input: string): Promise<{ recipient: string; domain: string | null }> {
  let recipient = input.trim();
  let domain: string | null = null;
  if (!recipient) throw new Error("Enter a recipient.");
  if (isAddress(recipient)) return { recipient, domain };
  if (isDomainName(recipient)) {
    const { resolveDomain } = await import("@/lib/monad/domain-resolver");
    const dom = extractDomain(recipient) ?? recipient;
    const resolution = await resolveDomain(dom);
    if (!resolution.resolvedAddress) throw new Error(`Couldn't resolve ${dom}. Check the name and try again.`);
    domain = resolution.domain;
    recipient = resolution.resolvedAddress;
    return { recipient, domain };
  }
  const payee = resolvePayee(recipient);
  if (!payee) throw new Error(`"${recipient}" isn't a valid address, .nad domain, or known payee.`);
  return { recipient: payee.address, domain };
}

function normalizeEndCondition(input: { type?: string; totalRuns?: number; untilMs?: number } | undefined, startAt: number): ScheduleEndCondition {
  if (input?.type === "after_count") {
    const totalRuns = Number(input.totalRuns);
    if (!Number.isFinite(totalRuns) || totalRuns < 1) throw new Error("Enter how many times this should run.");
    return { type: "after_count", totalRuns: Math.floor(totalRuns) };
  }
  if (input?.type === "until_date") {
    const untilMs = Number(input.untilMs);
    if (!Number.isFinite(untilMs) || untilMs <= startAt) throw new Error("The end date must be after the start date.");
    return { type: "until_date", untilMs };
  }
  return { type: "never" };
}

function signatureMessage(input: {
  walletAddress: string;
  recipient: string;
  amount: number;
  token: string;
  cadence: string;
  startAt: number;
  timezone: string;
  purpose: string;
}) {
  return [
    "PayAI Payment Automation",
    `Wallet: ${input.walletAddress}`,
    `Recipient: ${input.recipient}`,
    `Amount: ${input.amount} ${input.token}`,
    `Automation: ${input.cadence}`,
    `First execution: ${new Date(input.startAt).toISOString()}`,
    `Timezone: ${input.timezone}`,
    `Purpose: ${input.purpose}`,
    "Network: Monad Mainnet",
  ].join("\n");
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const recipientInput = url.searchParams.get("resolve");
  if (recipientInput != null) {
    try {
      const resolved = await resolveRecipient(recipientInput);
      return NextResponse.json({ success: true, ...resolved });
    } catch (e) {
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : "Recipient verification failed." }, { status: 422 });
    }
  }

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { listSchedules } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId);
  const automations = await listSchedules(merchantId, { sender });
  return NextResponse.json({ automations, schedules: automations });
}

export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: {
    walletAddress?: string; amount?: number; token?: string; recipient?: string;
    cadence?: string; startAt?: number; memo?: string; purpose?: string; timezone?: string;
    intervalCount?: number; intervalUnit?: string; signature?: string; signatureMessage?: string;
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
  const timezone = body.timezone?.trim() || "Africa/Lagos";
  const purpose = body.purpose?.trim() || body.memo?.trim() || "";

  if (!walletAddress) return NextResponse.json({ error: "Connect your wallet before creating an automation." }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter an amount greater than 0." }, { status: 400 });
  if (token !== "MON" && token !== "USDC") return NextResponse.json({ error: "Choose MON or USDC." }, { status: 400 });
  const cap = token === "MON" ? agentConfig.maxMon : agentConfig.maxUsd;
  if (amount > cap) return NextResponse.json({ error: `Amount exceeds the agent cap of ${cap.toLocaleString()} ${token} per payment.` }, { status: 422 });
  if (!CADENCES.includes(cadence)) return NextResponse.json({ error: "Choose a supported automation frequency." }, { status: 400 });
  if (!Number.isFinite(startAt) || startAt < Date.now() - 60_000) return NextResponse.json({ error: "Choose a future execution time." }, { status: 400 });
  if (!purpose) return NextResponse.json({ error: "Every automation needs a purpose." }, { status: 400 });

  const intervalCount = Math.max(1, Math.floor(Number(body.intervalCount) || 1));
  const intervalUnit = INTERVAL_UNITS.includes(body.intervalUnit as AutomationIntervalUnit) ? body.intervalUnit as AutomationIntervalUnit : "days";
  if (cadence === "custom" && (!Number.isFinite(intervalCount) || intervalCount < 1)) {
    return NextResponse.json({ error: "Custom automations must run every 1 or more days, weeks, or months." }, { status: 400 });
  }

  let resolved: { recipient: string; domain: string | null };
  let endCondition: ScheduleEndCondition;
  try {
    resolved = await resolveRecipient(recipientInput);
    endCondition = normalizeEndCondition(body.endCondition, startAt);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Automation validation failed." }, { status: 422 });
  }

  const expectedMessage = signatureMessage({ walletAddress, recipient: resolved.recipient, amount, token, cadence, startAt, timezone, purpose });
  if (!body.signature || body.signatureMessage !== expectedMessage) {
    return NextResponse.json({ error: "Confirm this automation in your wallet before creating it." }, { status: 401 });
  }
  const signed = await verifyMessage({ address: walletAddress as `0x${string}`, message: expectedMessage, signature: body.signature as `0x${string}` }).catch(() => false);
  if (!signed) return NextResponse.json({ error: "Wallet confirmation could not be verified." }, { status: 401 });

  // Creation-time duplicate-submission protection: a personal_sign signature
  // is deterministic for a given key + message, so signing the exact same
  // automation terms twice (a double-click past the client's own disabled-
  // while-saving guard, or a network retry after a lost response) produces
  // the identical signature — a natural idempotency key. Without this, a
  // retried request would silently create a second live recurring payment
  // with identical terms instead of returning the one that already exists.
  const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
  const { createHash } = await import("node:crypto");
  const createKey = `automation-create:${createHash("sha256").update(body.signature).digest("hex")}`;
  const claim = await claimRequest<{ automationId: string }>(createKey);
  if (!claim.claimed) {
    if (claim.status === "done" && claim.result) {
      const { getSchedule } = await import("@/lib/platform/schedules");
      const existing = await getSchedule(claim.result.automationId);
      if (existing) return NextResponse.json({ automation: existing, schedule: existing, success: true, replayed: true });
    }
    return NextResponse.json({ error: "This automation is already being created. Please wait." }, { status: 409 });
  }

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { createSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const row = await createSchedule(merchantId, {
    amount, token, recipient: resolved.recipient, domain: resolved.domain, cadence, nextRun: startAt,
    memo: body.memo ?? purpose, purpose, timezone, sender: walletAddress, endCondition,
    intervalCount: cadence === "custom" ? intervalCount : undefined,
    intervalUnit: cadence === "custom" ? intervalUnit : undefined,
    signature: body.signature,
    signatureMessage: expectedMessage,
  });
  await completeRequest(createKey, { automationId: row.id });
  return NextResponse.json({ automation: row, schedule: row, success: true });
}

export async function PATCH(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let body: {
    walletAddress?: string; action?: "pause" | "resume" | "cancel";
    amount?: number; cadence?: string; nextRun?: number; memo?: string; purpose?: string; timezone?: string;
    intervalCount?: number; intervalUnit?: string; endCondition?: { type?: string; totalRuns?: number; untilMs?: number };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId, body.walletAddress);

  if (body.action) {
    const { setScheduleStatus } = await import("@/lib/platform/schedules");
    const next = body.action === "pause" ? "paused" : body.action === "resume" ? "active" : "cancelled";
    const row = await setScheduleStatus(merchantId, id, next, { sender });
    if (!row) return NextResponse.json({ error: "Automation not found or not editable." }, { status: 404 });
    return NextResponse.json({ automation: row, success: true });
  }

  const patch: Record<string, unknown> = {};
  if (body.amount != null) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter an amount greater than 0." }, { status: 400 });
    patch.amount = amount;
  }
  if (body.cadence != null) {
    if (!CADENCES.includes(body.cadence as ScheduleCadence)) return NextResponse.json({ error: "Invalid automation frequency." }, { status: 400 });
    patch.cadence = body.cadence;
  }
  if (body.nextRun != null) {
    const nextRun = Number(body.nextRun);
    if (!Number.isFinite(nextRun) || nextRun < Date.now() - 60_000) return NextResponse.json({ error: "Choose a future time for the next execution." }, { status: 400 });
    patch.nextRun = nextRun;
  }
  if (body.memo != null) patch.memo = body.memo;
  if (body.purpose != null) patch.purpose = body.purpose;
  if (body.timezone != null) patch.timezone = body.timezone;
  if (body.intervalCount != null) patch.intervalCount = Math.max(1, Math.floor(Number(body.intervalCount) || 1));
  if (body.intervalUnit != null && INTERVAL_UNITS.includes(body.intervalUnit as AutomationIntervalUnit)) patch.intervalUnit = body.intervalUnit;
  if (body.endCondition) {
    try {
      patch.endCondition = normalizeEndCondition(body.endCondition, Number(body.nextRun ?? Date.now()));
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid end condition." }, { status: 400 });
    }
  }

  const { updateSchedule } = await import("@/lib/platform/schedules");
  const row = await updateSchedule(merchantId, id, patch, { sender });
  if (!row) return NextResponse.json({ error: "Automation not found, not editable, or not yours." }, { status: 404 });
  return NextResponse.json({ automation: row, success: true });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { deleteSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId);
  const ok = await deleteSchedule(merchantId, id, { sender });
  if (!ok) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  return NextResponse.json({ success: true });
}
