import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { agentConfig } from "@/lib/agent/brain";
import { isAddress } from "@/lib/payees/directory";
import { resolveRecipient } from "@/lib/payees/resolve";
import type { AutomationIntervalUnit, ScheduleCadence, ScheduleEndCondition } from "@/lib/platform/types";
import { VALID_TEMPLATE_CATEGORIES } from "@/lib/automation/templates";
import { computeDistribution, findDuplicateInputs, type DistributionMethod } from "@/lib/automation/bulk";
import { resolveToken, NATIVE_TOKEN_ADDRESS, type TokenInfo } from "@/lib/monad/tokenRegistry";
import { createHash } from "node:crypto";
import { hashSignature } from "@/lib/platform/idempotency";
import { toBaseUnits } from "@/lib/monad/verify";

/**
 * Resolve the token for a creation request. `tokenAddress` (sent by the
 * token-agnostic picker) is the real source of truth and works for ANY
 * Monad token; `symbolHint` is only a fallback for a client that hasn't
 * picked up the new selector yet (legacy MON/USDC-only behavior).
 */
async function resolveCreationToken(tokenAddress: string | undefined, symbolHint: string): Promise<TokenInfo> {
  if (tokenAddress) return resolveToken(tokenAddress);
  if (symbolHint === "MON") return resolveToken(NATIVE_TOKEN_ADDRESS);
  if (symbolHint === "USDC") {
    const { getStablecoin } = await import("@/lib/monad/config");
    const s = getStablecoin();
    return { address: s.address, symbol: s.symbol, name: s.symbol, decimals: s.decimals, logoURI: null, verified: true };
  }
  throw new Error("Choose a token.");
}

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

/**
 * Bulk Payments' signed message. Deterministic and re-derivable server-side
 * from the exact same resolved rows, same principle as signatureMessage()
 * above — the wallet must sign the REAL terms (every resolved address and
 * amount), not a summary of them, so a tampered recipient list after
 * signing is caught here rather than trusted. A hash of the row list keeps
 * the signed message a reasonable size regardless of recipient count.
 */
function bulkSignatureMessage(input: {
  walletAddress: string; token: string; cadence: string; startAt: number;
  timezone: string; purpose: string; distributionMethod: string;
  rows: { address: string; amount: number }[];
}) {
  const rowsDigest = createHash("sha256")
    .update(input.rows.map((r) => `${r.address.toLowerCase()}:${r.amount}`).join("|"))
    .digest("hex");
  const total = input.rows.reduce((s, r) => s + r.amount, 0);
  return [
    "PayAI Bulk Payment",
    `Wallet: ${input.walletAddress}`,
    `Recipients: ${input.rows.length}`,
    `Recipients digest: ${rowsDigest}`,
    `Total: ${total} ${input.token}`,
    `Distribution: ${input.distributionMethod}`,
    `Automation: ${input.cadence}`,
    `First execution: ${new Date(input.startAt).toISOString()}`,
    `Timezone: ${input.timezone}`,
    `Purpose: ${input.purpose}`,
    "Network: Monad Mainnet",
  ].join("\n");
}

/**
 * Bulk Payments creation. Deliberately a separate function, not a branch
 * threaded through the single-recipient POST above — the validation shape
 * (N addresses + a distribution method, not one address + one amount) is
 * different enough that forcing it through the same code path would make
 * both harder to read. It still ends at the exact same createSchedule() the
 * single-recipient path uses; only the fan-out into `recipients` is new.
 */
async function handleBulkCreate(
  req: NextRequest,
  body: {
    walletAddress?: string; token?: string; tokenAddress?: string; cadence?: string; startAt?: number;
    memo?: string; purpose?: string; timezone?: string;
    intervalCount?: number; intervalUnit?: string; signature?: string; signatureMessage?: string;
    endCondition?: { type?: string; totalRuns?: number; untilMs?: number };
    fundingMode?: string; templateId?: string; templateCategory?: string;
    recipients?: { input: string; amount: number; note?: string }[];
    distributionMethod?: string;
  },
): Promise<NextResponse> {
  const walletAddress = body.walletAddress && isAddress(body.walletAddress) ? body.walletAddress : null;
  const token = (body.token || "").toUpperCase();
  const cadence = body.cadence as ScheduleCadence;
  const startAt = Number(body.startAt);
  const timezone = body.timezone?.trim() || "Africa/Lagos";
  const purpose = body.purpose?.trim() || body.memo?.trim() || "";
  const drafts = body.recipients ?? [];
  const method = body.distributionMethod as DistributionMethod;

  if (!walletAddress) return NextResponse.json({ error: "Connect your wallet before creating a bulk payment." }, { status: 400 });
  let resolvedToken: TokenInfo;
  try {
    resolvedToken = await resolveCreationToken(body.tokenAddress, token);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Choose a token." }, { status: 400 });
  }
  if (!CADENCES.includes(cadence)) return NextResponse.json({ error: "Choose a supported automation frequency." }, { status: 400 });
  if (!Number.isFinite(startAt) || startAt < Date.now() - 60_000) return NextResponse.json({ error: "Choose a future execution time." }, { status: 400 });
  if (!purpose) return NextResponse.json({ error: "Every automation needs a purpose." }, { status: 400 });
  if (!["equal", "fixed", "percentage", "custom"].includes(method)) {
    return NextResponse.json({ error: "Choose a distribution method." }, { status: 400 });
  }
  if (drafts.length === 0) return NextResponse.json({ error: "Add at least one recipient." }, { status: 400 });
  if (drafts.length > 500) return NextResponse.json({ error: "A single bulk payment supports up to 500 recipients." }, { status: 400 });

  // Reserved Funds is a hard rejection here, not a soft default, because the
  // reason is a real on-chain constraint, not a policy choice: AutomationVault
  // locks a reservation to exactly one recipient at reserve time. There is no
  // way to honor "reserve funds for a bulk payment" without changing that
  // contract, so we refuse rather than silently create something that could
  // never actually execute.
  const fundingMode: "wallet" | "reserved" = body.fundingMode === "reserved" ? "reserved" : "wallet";
  if (fundingMode === "reserved") {
    return NextResponse.json({
      error: "Reserved Funds isn't available for Bulk Payments — the vault contract can only guarantee one recipient per reservation. Use Wallet Automation instead.",
      code: "BULK_RESERVED_UNSUPPORTED",
    }, { status: 422 });
  }

  const dupInputs = findDuplicateInputs(drafts.map((d) => ({ input: d.input })));
  if (dupInputs.length > 0) {
    return NextResponse.json({ error: `Duplicate recipient entered: ${dupInputs[0]}. Remove the duplicate and try again.` }, { status: 400 });
  }

  // Re-resolve every recipient server-side — never trust addresses the
  // client already "resolved". Same resolveRecipient() a single-recipient
  // automation uses, called once per row.
  const resolvedRows: { input: string; address: string; domain: string | null; amount: number; note?: string }[] = [];
  for (const d of drafts) {
    try {
      const r = await resolveRecipient(d.input);
      resolvedRows.push({ input: d.input, address: r.recipient, domain: r.domain, amount: d.amount, note: d.note });
    } catch (e) {
      return NextResponse.json({ error: `"${d.input}": ${e instanceof Error ? e.message : "could not be resolved."}` }, { status: 422 });
    }
  }

  // Duplicate ADDRESSES (two different inputs resolving to the same 0x
  // address — e.g. an address pasted once and a .nad domain that resolves
  // to it) can only be caught after resolution, unlike duplicate raw inputs
  // above.
  const seenAddresses = new Set<string>();
  for (const r of resolvedRows) {
    const key = r.address.toLowerCase();
    if (seenAddresses.has(key)) {
      return NextResponse.json({ error: `Two entries resolve to the same address (${r.domain ?? r.address}). Remove the duplicate.` }, { status: 400 });
    }
    seenAddresses.add(key);
  }

  const distribution = computeDistribution(method, resolvedRows.map((r) => ({ input: r.input, amount: r.amount, percentage: undefined })), undefined);
  // computeDistribution above is for re-deriving amounts from a total for
  // equal/fixed/percentage; here amounts were already assigned per-row by
  // the client for custom/fixed, or by the client's own equal/percentage
  // split before signing. What matters server-side is that every resolved
  // row already has a real positive amount — re-validate that directly
  // rather than re-deriving (the client doesn't send percentages/total back,
  // only the final per-row amounts it already computed and the user reviewed).
  void distribution;
  for (const r of resolvedRows) {
    if (!Number.isFinite(r.amount) || r.amount <= 0) {
      return NextResponse.json({ error: `"${r.domain ?? r.input}" has an invalid amount.` }, { status: 400 });
    }
  }

  const totalAmount = resolvedRows.reduce((s, r) => s + r.amount, 0);
  // No USD price oracle exists yet (see lib/monad/tokenRegistry.ts), so an
  // arbitrary ERC-20's real-world value can't be capped precisely — it
  // reuses the same generic non-native cap as USDC always did, same
  // limitation the on-chain contract itself has (one bucket per native/ERC-20).
  const cap = resolvedToken.address === NATIVE_TOKEN_ADDRESS ? agentConfig.maxMon : agentConfig.maxUsd;
  for (const r of resolvedRows) {
    if (r.amount > cap) {
      return NextResponse.json({ error: `Amount to "${r.domain ?? r.input}" (${r.amount} ${resolvedToken.symbol}) exceeds the agent cap of ${cap.toLocaleString()} per payment.` }, { status: 422 });
    }
  }

  const intervalCount = Math.max(1, Math.floor(Number(body.intervalCount) || 1));
  const intervalUnit = INTERVAL_UNITS.includes(body.intervalUnit as AutomationIntervalUnit) ? body.intervalUnit as AutomationIntervalUnit : "days";

  let endCondition: ScheduleEndCondition;
  try {
    endCondition = normalizeEndCondition(body.endCondition, startAt);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Automation validation failed." }, { status: 422 });
  }

  const expectedMessage = bulkSignatureMessage({
    walletAddress, token, cadence, startAt, timezone, purpose, distributionMethod: method,
    rows: resolvedRows.map((r) => ({ address: r.address, amount: r.amount })),
  });
  if (!body.signature || body.signatureMessage !== expectedMessage) {
    return NextResponse.json({ error: "Confirm this bulk payment in your wallet before creating it." }, { status: 401 });
  }
  const signed = await verifyMessage({ address: walletAddress as `0x${string}`, message: expectedMessage, signature: body.signature as `0x${string}` }).catch(() => false);
  if (!signed) return NextResponse.json({ error: "Wallet confirmation could not be verified." }, { status: 401 });

  const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
  const createKey = `automation-create:${hashSignature(body.signature)}`;
  const claim = await claimRequest<{ automationId: string }>(createKey);
  if (!claim.claimed) {
    if (claim.status === "done" && claim.result) {
      const { getSchedule } = await import("@/lib/platform/schedules");
      const existing = await getSchedule(claim.result.automationId);
      if (existing) return NextResponse.json({ automation: existing, schedule: existing, success: true, replayed: true });
    }
    return NextResponse.json({ error: "This bulk payment is already being created. Please wait." }, { status: 409 });
  }

  // Same allowance check a single-recipient Wallet Automation does — the
  // agent still pulls from ONE approving wallet (the creator's), it just
  // pulls it out to N different recipients across the run instead of one.
  // Any token's own address works here now — native MON is the only case
  // needing a substitute (WMON), since a native coin has no ERC-20 allowance.
  const { getWrappedNative, getPaymentExecutor } = await import("@/lib/monad/config");
  const isNative = resolvedToken.address === NATIVE_TOKEN_ADDRESS;
  const executor = getPaymentExecutor();
  if (isNative && !getWrappedNative()) {
    return NextResponse.json({ error: "MON isn't available for Bulk Payments yet — choose an ERC-20 token.", code: "WALLET_MODE_MON_UNSUPPORTED" }, { status: 422 });
  }
  if (!isNative && executor) {
    try {
      const { getPublicClient } = await import("@/lib/monad/wallet");
      const need = toBaseUnits(totalAmount, resolvedToken.decimals);
      const allowance = (await getPublicClient().readContract({
        address: resolvedToken.address as `0x${string}`, abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "allowance", args: [walletAddress as `0x${string}`, executor],
      })) as bigint;
      if (allowance < need) {
        return NextResponse.json({ error: "Approve PayAI to send this token from your wallet before creating the bulk payment.", code: "APPROVAL_REQUIRED" }, { status: 402 });
      }
    } catch {
      /* RPC hiccup — don't hard-block creation; execution re-checks allowance anyway. */
    }
  }

  const templateCategory = body.templateCategory && VALID_TEMPLATE_CATEGORIES.includes(body.templateCategory) ? body.templateCategory : null;
  const templateId = templateCategory && body.templateId ? body.templateId : null;

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { createSchedule } = await import("@/lib/platform/schedules");
  const merchantId = await resolveTenantId(req);
  const first = resolvedRows[0];
  const row = await createSchedule(merchantId, {
    // Representative single-recipient fields, for any code that isn't
    // bulk-aware — the real per-recipient breakdown is in `recipients`.
    amount: totalAmount, token: resolvedToken.symbol,
    tokenAddress: resolvedToken.address, tokenDecimals: resolvedToken.decimals, tokenLogo: resolvedToken.logoURI,
    recipient: first.address, domain: first.domain,
    cadence, nextRun: startAt, memo: body.memo ?? purpose, purpose, timezone,
    sender: walletAddress, endCondition,
    intervalCount: cadence === "custom" ? intervalCount : undefined,
    intervalUnit: cadence === "custom" ? intervalUnit : undefined,
    signature: body.signature, signatureMessage: expectedMessage,
    fundingMode, templateId, templateCategory,
    recipients: resolvedRows.map((r) => ({ input: r.input, address: r.address, domain: r.domain, amount: r.amount, note: r.note })),
    distributionMethod: method,
    // Same per-automation contract pinning as the single-recipient path.
    executorAddress: executor ?? null,
    vaultAddress: (await import("@/lib/monad/config")).getAutomationVault() ?? null,
  });
  await completeRequest(createKey, { automationId: row.id });
  return NextResponse.json({ automation: row, schedule: row, success: true });
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
  const { denyPrivateRead } = await import("@/lib/auth/walletGrant");
  const denied = await denyPrivateRead(req, sender);
  if (denied) return denied;
  const automations = await listSchedules(merchantId, { sender });
  return NextResponse.json({ automations, schedules: automations });
}

export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: {
    walletAddress?: string; amount?: number; token?: string; tokenAddress?: string; recipient?: string;
    cadence?: string; startAt?: number; memo?: string; purpose?: string; timezone?: string;
    intervalCount?: number; intervalUnit?: string; signature?: string; signatureMessage?: string;
    endCondition?: { type?: string; totalRuns?: number; untilMs?: number };
    fundingMode?: string; reserveTxHash?: string; id?: string;
    templateId?: string; templateCategory?: string;
    // Bulk Payments only.
    recipients?: { input: string; amount: number; note?: string }[];
    distributionMethod?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (Array.isArray(body.recipients)) {
    return handleBulkCreate(req, body);
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
  let resolvedToken: TokenInfo;
  try {
    resolvedToken = await resolveCreationToken(body.tokenAddress, token);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Choose a token." }, { status: 400 });
  }
  // No USD price oracle exists yet (see lib/monad/tokenRegistry.ts), so an
  // arbitrary ERC-20's real-world value can't be capped precisely — it
  // reuses the same generic non-native cap as USDC always did, same
  // limitation the on-chain contract itself has (one bucket per native/ERC-20).
  const cap = resolvedToken.address === NATIVE_TOKEN_ADDRESS ? agentConfig.maxMon : agentConfig.maxUsd;
  if (amount > cap) return NextResponse.json({ error: `Amount exceeds the agent cap of ${cap.toLocaleString()} ${resolvedToken.symbol} per payment.` }, { status: 422 });
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
  const createKey = `automation-create:${hashSignature(body.signature)}`;
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
      const need = toBaseUnits(amount, resolvedToken.decimals);
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
    const isNative = resolvedToken.address === NATIVE_TOKEN_ADDRESS;
    const executor = getPaymentExecutor();
    if (isNative && !getWrappedNative()) {
      return NextResponse.json({ error: "MON automations use Reserved Funds. Choose Reserved Funds mode for MON, or use an ERC-20 token for Wallet Automation.", code: "WALLET_MODE_MON_UNSUPPORTED" }, { status: 422 });
    }
    // Verify the user actually approved the executor to pull this token.
    if (!isNative && executor) {
      try {
        const { getPublicClient } = await import("@/lib/monad/wallet");
        const need = toBaseUnits(amount, resolvedToken.decimals);
        const allowance = (await getPublicClient().readContract({
          address: resolvedToken.address as `0x${string}`, abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }],
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
    amount, token: resolvedToken.symbol,
    tokenAddress: resolvedToken.address, tokenDecimals: resolvedToken.decimals, tokenLogo: resolvedToken.logoURI,
    recipient: resolved.recipient, domain: resolved.domain, cadence, nextRun: startAt,
    memo: body.memo ?? purpose, purpose, timezone, sender: walletAddress, endCondition,
    intervalCount: cadence === "custom" ? intervalCount : undefined,
    intervalUnit: cadence === "custom" ? intervalUnit : undefined,
    signature: body.signature,
    signatureMessage: expectedMessage,
    fundingMode,
    reserveTxHash: body.reserveTxHash ?? null,
    id: fundingMode === "reserved" ? body.id : undefined,
    templateId, templateCategory,
    // Stamp whichever contract is actually live right now, so a later
    // redeploy only affects automations created AFTER it — this one keeps
    // executing/releasing against the exact address recorded here forever.
    executorAddress: (await import("@/lib/monad/config")).getPaymentExecutor() ?? null,
    vaultAddress: (await import("@/lib/monad/config")).getAutomationVault() ?? null,
  });
  await completeRequest(createKey, { automationId: row.id });
  return NextResponse.json({ automation: row, schedule: row, success: true });
}

export async function PATCH(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  let body: {
    walletAddress?: string; action?: "pause" | "resume" | "cancel" | "skip_next" | "execute_now" | "report_self_refund";
    signature?: string; timestamp?: number;
    amount?: number; cadence?: string; nextRun?: number; memo?: string; purpose?: string; timezone?: string;
    intervalCount?: number; intervalUnit?: string; endCondition?: { type?: string; totalRuns?: number; untilMs?: number };
    refundTxHash?: string;
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
    const { executeScheduleNow, executeBulkScheduleNow } = await import("@/lib/automation/execute");
    const { claimRequest, completeRequest, releaseRequest } = await import("@/lib/platform/idempotency");
    const row = await getSchedule(id);
    if (!row || row.merchantId !== merchantId) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
    if (sender && (row.sender ?? "").toLowerCase() !== sender.toLowerCase()) {
      return NextResponse.json({ error: "This automation isn't yours." }, { status: 404 });
    }
    if (row.status !== "active" && row.status !== "scheduled") {
      return NextResponse.json({ error: "Only an active automation can be run now." }, { status: 409 });
    }
    // verifyMutation() above already required a non-empty body.signature to
    // reach here — this re-check exists only to narrow the type for the hash
    // below, not because the runtime case is actually reachable.
    if (!body.signature) return NextResponse.json({ error: "Confirm this action in your wallet." }, { status: 401 });
    // Distinct from the cron's due-slot key (`sch:{id}:{nextRun}`) so a manual
    // trigger never collides with — or gets silently absorbed by — whatever
    // the scheduler is doing with this same automation's regular occurrence.
    // Keyed off the wallet signature, not Date.now(): the signature is
    // already unique per explicit user action (signMutation mints a fresh
    // timestamp/signature on every real click — see automations/page.tsx),
    // but stable across a retry of that same signed request, so a duplicate
    // delivery of the identical proof collides on this key instead of
    // minting a brand new one every time and defeating claimRequest below —
    // the same signature-keyed pattern already used for automation-create.
    const requestId = `sch:${id}:manual:${hashSignature(body.signature)}`;
    const claim = await claimRequest<{ outcome: string; txHash?: string }>(requestId);
    if (!claim.claimed) return NextResponse.json({ error: "This automation is already running. Please wait." }, { status: 409 });
    try {
      const { recordAutomationEvent } = await import("@/lib/platform/automationEvents");
      const isBulk = !!row.recipients?.length;
      await recordAutomationEvent({
        merchantId, automationId: id, sender: row.sender, type: "execution_started",
        title: "Execution started",
        detail: isBulk ? `Sending to ${row.recipients?.length ?? 0} recipients now.` : `${row.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${row.token} to ${row.domain ?? row.recipient} is being sent now.`,
        amount: row.amount, token: row.token,
      });
      if (row.recipients?.length) {
        const bulkResult = await executeBulkScheduleNow(row, requestId);
        await recordRun(id, { at: Date.now(), decision: bulkResult.outcome, recipientResults: bulkResult.recipientResults, durationMs: bulkResult.durationMs });
        await completeRequest(requestId, { outcome: bulkResult.outcome });
        const updated = await getSchedule(id);
        return NextResponse.json({ automation: updated, success: true, outcome: bulkResult.outcome, recipientResults: bulkResult.recipientResults });
      }
      const result = await executeScheduleNow(row, requestId);
      await recordRun(id, { at: Date.now(), decision: result.outcome, txHash: result.txHash, explorerUrl: result.explorerUrl, detail: result.detail, durationMs: result.durationMs });
      await completeRequest(requestId, { outcome: result.outcome, txHash: result.txHash });
      const updated = await getSchedule(id);
      return NextResponse.json({ automation: updated, success: true, outcome: result.outcome, txHash: result.txHash, explorerUrl: result.explorerUrl });
    } catch (e) {
      await releaseRequest(requestId);
      return NextResponse.json({ error: e instanceof Error ? e.message : "Execution failed." }, { status: 502 });
    }
  }

  if (body.action === "report_self_refund") {
    // The dashboard's "Recover reserved funds" tool lets the user call
    // AutomationVault.refund() DIRECTLY from their own wallet, bypassing the
    // agent entirely (the whole point of Reserved Funds being non-custodial:
    // this must work even if PayAI's agent is down or unwilling). But that
    // means the server's own row never heard about it — without this,
    // reserveRefundStatus would stay "pending" forever even after the user
    // already got their money back, which is exactly the false-alarm this
    // endpoint exists to close. The wallet signature above only proves WHO
    // is claiming this; the actual proof that funds moved is verified
    // on-chain below, never taken on the client's word alone.
    const { getSchedule } = await import("@/lib/platform/schedules");
    const row = await getSchedule(id);
    if (!row || row.merchantId !== merchantId) return NextResponse.json({ error: "Automation not found." }, { status: 404 });
    if (sender && (row.sender ?? "").toLowerCase() !== sender.toLowerCase()) {
      return NextResponse.json({ error: "This automation isn't yours." }, { status: 404 });
    }
    if (row.fundingMode !== "reserved") return NextResponse.json({ error: "Not a Reserved Funds automation." }, { status: 400 });
    if (!body.refundTxHash || !/^0x[0-9a-fA-F]{64}$/.test(body.refundTxHash)) {
      return NextResponse.json({ error: "A valid transaction hash is required." }, { status: 400 });
    }
    try {
      const { getPublicClient } = await import("@/lib/monad/wallet");
      const { requestId32 } = await import("@/lib/monad/contracts");
      const { AUTOMATION_VAULT_ABI } = await import("@/lib/monad/abi");
      const { getAutomationVault } = await import("@/lib/monad/config");
      const { decodeEventLog } = await import("viem");
      const vault = (row.vaultAddress as `0x${string}` | null) ?? getAutomationVault();
      if (!vault) return NextResponse.json({ error: "Vault unavailable." }, { status: 503 });

      const pub = getPublicClient();
      const receipt = await pub.getTransactionReceipt({ hash: body.refundTxHash as `0x${string}` });
      if (receipt.status !== "success") return NextResponse.json({ error: "That transaction did not succeed." }, { status: 422 });

      const autoIdBytes = requestId32(id);
      const matched = receipt.logs
        .filter((l) => l.address.toLowerCase() === vault.toLowerCase())
        .map((l) => {
          try {
            return decodeEventLog({ abi: AUTOMATION_VAULT_ABI, data: l.data, topics: l.topics });
          } catch {
            return null;
          }
        })
        .find(
          (ev) =>
            ev?.eventName === "Refunded" &&
            (ev.args as { automationId?: string }).automationId?.toLowerCase() === autoIdBytes.toLowerCase(),
        );
      if (!matched) {
        return NextResponse.json({ error: "That transaction doesn't match a refund for this automation." }, { status: 422 });
      }

      const args = matched.args as { amount: bigint };
      const decimals = row.tokenDecimals ?? (row.token === "MON" ? 18 : 6);
      const amount = Number(args.amount) / 10 ** decimals;
      const { recordSelfReportedRefund } = await import("@/lib/platform/schedules");
      const updated = await recordSelfReportedRefund(id, { txHash: body.refundTxHash, amount });
      return NextResponse.json({ automation: updated, success: true });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not verify that refund." }, { status: 502 });
    }
  }

  if (body.action) {
    const ACTION_TO_STATUS: Record<string, "paused" | "active" | "cancelled"> = {
      pause: "paused",
      resume: "active",
      cancel: "cancelled",
    };
    const next = ACTION_TO_STATUS[body.action as string];
    if (!next) return NextResponse.json({ error: "Unknown automation action." }, { status: 400 });
    const { setScheduleStatus } = await import("@/lib/platform/schedules");
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
