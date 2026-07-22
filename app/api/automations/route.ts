import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { agentConfig } from "@/lib/agent/brain";
import { isAddress, resolvePayee } from "@/lib/payees/directory";
import { isDomainName, extractDomain } from "@/lib/monad/domain-resolver";
import type { AutomationIntervalUnit, ScheduleCadence, ScheduleEndCondition } from "@/lib/platform/types";
import { VALID_TEMPLATE_CATEGORIES } from "@/lib/automation/templates";

const CADENCES: ScheduleCadence[] = ["once", "daily", "weekly", "monthly", "custom"];
const INTERVAL_UNITS: AutomationIntervalUnit[] = ["days", "weeks", "months"];

async function senderScopeFor(req: NextRequest, merchantId: string, walletFromBody?: string): Promise<string | null> {
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  if (merchantId !== DEMO_TENANT) return null;
  const w = (walletFromBody ?? new URL(req.url).searchParams.get("wallet"))?.trim();
  return w && isAddress(w) ? w : "__none__";
}

const MUTATION_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

function mutationMessage(input: { walletAddress: string; automationId: string; action: string; timestamp: number }) {
  return [
    "PayAI Automation Update",
    `Wallet: ${input.walletAddress}`,
    `Automation: ${input.automationId}`,
    `Action: ${input.action}`,
    `Timestamp: ${input.timestamp}`,
  ].join("\n");
}

/**
 * Every mutation to an existing automation (edit, pause, resume, cancel,
 * delete) — not just its creation — requires proof the caller actually
 * controls the wallet that owns it. A wallet address is public information
 * (visible in any transaction) and an automation id is returned to the
 * client, so without this, anyone who knew both could pause, cancel, or
 * edit someone else's live recurring payment by sending a plain HTTP
 * request with a claimed address — no signature required at all. This
 * closes that gap the same way creation already requires a signature.
 *
 * The timestamp inside the signed message is checked against a 5-minute
 * window so a captured signature can't be replayed indefinitely — it's a
 * one-shot proof-of-intent for this specific action, not a standing key.
 */
async function verifyMutation(input: {
  walletAddress?: string; automationId: string; action: string;
  signature?: string; timestamp?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.walletAddress || !isAddress(input.walletAddress)) return { ok: false, error: "A valid wallet address is required." };
  if (!input.signature || !input.timestamp) return { ok: false, error: "Confirm this action in your wallet." };
  if (Math.abs(Date.now() - input.timestamp) > MUTATION_SIGNATURE_WINDOW_MS) return { ok: false, error: "This confirmation has expired — try again." };
  const message = mutationMessage({ walletAddress: input.walletAddress, automationId: input.automationId, action: input.action, timestamp: input.timestamp });
  const signed = await verifyMessage({ address: input.walletAddress as `0x${string}`, message, signature: input.signature as `0x${string}` }).catch(() => false);
  if (!signed) return { ok: false, error: "Wallet confirmation could not be verified." };
  return { ok: true };
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
    fundingMode?: string; reserveTxHash?: string; id?: string;
    templateId?: string; templateCategory?: string;
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

  // Funding mode — Wallet Automation (non-custodial pull) is the default.
  const fundingMode: "wallet" | "reserved" = body.fundingMode === "reserved" ? "reserved" : "wallet";

  if (fundingMode === "reserved") {
    // Reserved Funds: the browser already deposited into the AutomationVault
    // keyed by this client-generated id. Verify the reservation actually
    // exists and covers this payment before creating the record, so we never
    // save a "guaranteed" automation whose funds aren't really there.
    const clientId = typeof body.id === "string" && /^sch_[a-zA-Z0-9-]{8,}$/.test(body.id) ? body.id : null;
    if (!clientId) return NextResponse.json({ error: "Reserved Funds requires a valid reservation id.", code: "RESERVE_ID_REQUIRED" }, { status: 400 });
    try {
      const { getAutomationVault } = await import("@/lib/monad/config");
      const { getPublicClient } = await import("@/lib/monad/wallet");
      const { requestId32 } = await import("@/lib/monad/contracts");
      const { AUTOMATION_VAULT_ABI } = await import("@/lib/monad/abi");
      const vault = getAutomationVault();
      if (!vault) return NextResponse.json({ error: "Reserved Funds is not available right now.", code: "VAULT_UNAVAILABLE" }, { status: 503 });
      const decimals = token === "MON" ? 18 : (await import("@/lib/monad/config")).getStablecoin().decimals;
      const need = BigInt(Math.round(amount * 10 ** decimals));
      const reserved = (await getPublicClient().readContract({
        address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "reservedBalance", args: [requestId32(clientId)],
      })) as bigint;
      if (reserved < need) {
        return NextResponse.json({ error: "We couldn't confirm your reserved funds on-chain yet. If you just reserved, wait a moment and try again.", code: "RESERVATION_NOT_CONFIRMED" }, { status: 402 });
      }
    } catch {
      return NextResponse.json({ error: "Could not verify your reservation on-chain. Please try again.", code: "RESERVATION_CHECK_FAILED" }, { status: 502 });
    }
  }

  if (fundingMode === "wallet") {
    // Wallet mode pulls a pre-approved ERC-20. Native MON has no allowance,
    // so it needs WMON; if WMON isn't configured, steer the user to Reserved
    // Funds rather than create an automation that can never execute.
    const { getWrappedNative, getPaymentExecutor } = await import("@/lib/monad/config");
    const isNative = token === "MON";
    const executor = getPaymentExecutor();
    if (isNative && !getWrappedNative()) {
      return NextResponse.json({ error: "MON automations use Reserved Funds. Choose Reserved Funds mode for MON, or use USDC for Wallet Automation.", code: "WALLET_MODE_MON_UNSUPPORTED" }, { status: 422 });
    }
    // Verify the user actually approved the executor to pull this token.
    if (!isNative && executor) {
      try {
        const { getPublicClient } = await import("@/lib/monad/wallet");
        const { getStablecoin } = await import("@/lib/monad/config");
        const stable = getStablecoin();
        const need = BigInt(Math.round(amount * 10 ** stable.decimals));
        const allowance = (await getPublicClient().readContract({
          address: stable.address, abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }],
          functionName: "allowance", args: [walletAddress as `0x${string}`, executor],
        })) as bigint;
        if (allowance < need) {
          return NextResponse.json({ error: "Approve PayAI to send this token from your wallet before creating the automation.", code: "APPROVAL_REQUIRED" }, { status: 402 });
        }
      } catch {
        /* RPC hiccup — don't hard-block creation; execution re-checks allowance anyway. */
      }
    }
  }

  // Template attribution is a label only — validated against the known
  // category list so a bad/typo'd value never gets stored, but never
  // required and never consulted by execution.
  const templateCategory = body.templateCategory && VALID_TEMPLATE_CATEGORIES.includes(body.templateCategory)
    ? body.templateCategory
    : null;
  const templateId = templateCategory && body.templateId ? body.templateId : null;

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
    fundingMode,
    reserveTxHash: body.reserveTxHash ?? null,
    id: fundingMode === "reserved" ? body.id : undefined,
    templateId, templateCategory,
  });
  await completeRequest(createKey, { automationId: row.id });
  return NextResponse.json({ automation: row, schedule: row, success: true });
}

export async function PATCH(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let body: {
    walletAddress?: string; action?: "pause" | "resume" | "cancel" | "skip_next" | "execute_now";
    signature?: string; timestamp?: number;
    amount?: number; cadence?: string; nextRun?: number; memo?: string; purpose?: string; timezone?: string;
    intervalCount?: number; intervalUnit?: string; endCondition?: { type?: string; totalRuns?: number; untilMs?: number };
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const verified = await verifyMutation({
    walletAddress: body.walletAddress, automationId: id, action: body.action ?? "edit",
    signature: body.signature, timestamp: body.timestamp,
  });
  if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 401 });

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId, body.walletAddress);

  if (body.action === "skip_next") {
    const { skipNextRun } = await import("@/lib/platform/schedules");
    const row = await skipNextRun(merchantId, id, { sender });
    if (!row) return NextResponse.json({ error: "Automation not found, not active, or not yours." }, { status: 404 });
    return NextResponse.json({ automation: row, success: true });
  }

  if (body.action === "execute_now") {
    const { getSchedule, recordRun } = await import("@/lib/platform/schedules");
    const { executeScheduleNow } = await import("@/lib/automation/execute");
    const { claimRequest, completeRequest, releaseRequest } = await import("@/lib/platform/idempotency");
    const row = await getSchedule(id);
    if (!row || row.merchantId !== merchantId) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
    if (sender && (row.sender ?? "").toLowerCase() !== sender.toLowerCase()) {
      return NextResponse.json({ error: "This automation isn't yours." }, { status: 404 });
    }
    if (row.status !== "active" && row.status !== "scheduled") {
      return NextResponse.json({ error: "Only an active automation can be run now." }, { status: 409 });
    }
    // Distinct from the cron's due-slot key (`sch:{id}:{nextRun}`) so a manual
    // trigger never collides with — or gets silently absorbed by — whatever
    // the scheduler is doing with this same automation's regular occurrence.
    const requestId = `sch:${id}:manual:${Date.now()}`;
    const claim = await claimRequest<{ outcome: string; txHash?: string }>(requestId);
    if (!claim.claimed) return NextResponse.json({ error: "This automation is already running. Please wait." }, { status: 409 });
    try {
      const result = await executeScheduleNow(row, requestId);
      await recordRun(id, { at: Date.now(), decision: result.outcome, txHash: result.txHash, explorerUrl: result.explorerUrl, detail: result.detail });
      await completeRequest(requestId, { outcome: result.outcome, txHash: result.txHash });
      const updated = await getSchedule(id);
      return NextResponse.json({ automation: updated, success: true, outcome: result.outcome, txHash: result.txHash, explorerUrl: result.explorerUrl });
    } catch (e) {
      await releaseRequest(requestId);
      return NextResponse.json({ error: e instanceof Error ? e.message : "Execution failed." }, { status: 502 });
    }
  }

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

  // Material terms are the ones that change what/when money moves. If any of
  // them changed, stamp modifiedAt so the record no longer silently contradicts
  // its original creation signature (which still describes the ORIGINAL terms).
  // The edit was already gated by a fresh action-scoped signature above, so
  // this marks a re-authorized change, not an unauthorized one.
  const MATERIAL_FIELDS = ["amount", "cadence", "nextRun", "intervalCount", "intervalUnit", "endCondition"] as const;
  if (MATERIAL_FIELDS.some((f) => f in patch)) patch.modifiedAt = Date.now();

  const { updateSchedule } = await import("@/lib/platform/schedules");
  const row = await updateSchedule(merchantId, id, patch, { sender });
  if (!row) return NextResponse.json({ error: "Automation not found, not editable, or not yours." }, { status: 404 });
  return NextResponse.json({ automation: row, success: true });
}

export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let body: { walletAddress?: string; signature?: string; timestamp?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* DELETE with no body is fine if the caller only used query params before —
       verifyMutation below will reject it for lacking a signature either way. */
  }
  const walletAddress = body.walletAddress ?? new URL(req.url).searchParams.get("wallet") ?? undefined;

  const verified = await verifyMutation({ walletAddress, automationId: id, action: "delete", signature: body.signature, timestamp: body.timestamp });
  if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 401 });

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { deleteSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const sender = await senderScopeFor(req, merchantId, walletAddress);
  const ok = await deleteSchedule(merchantId, id, { sender });
  if (!ok) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  return NextResponse.json({ success: true });
}
