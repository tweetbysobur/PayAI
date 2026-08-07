/**
 * The ONE place a Payment Automation actually settles a payment. Both the
 * cron batch runner (app/api/cron/run-schedules/route.ts) and a manual
 * "Execute Now" trigger (app/api/automations/route.ts PATCH) call this same
 * function — there is no second execution path. This is what "Automation
 * Templates/Bulk Payments use the existing engine, never a separate one"
 * means in practice: even a Bulk Payment (N recipients) is just this exact
 * single-payment pipeline called once per recipient, via executeOnePayment
 * below — there is no separate "bulk executor," only a loop around the same
 * function a single-recipient automation calls once.
 *
 * Server-only.
 */
import "server-only";
import type { PaymentRequest } from "@/lib/payment/types";
import type { ScheduledPayment, BulkRecipientResult } from "@/lib/platform/types";

export interface ScheduleExecutionResult {
  outcome: "executed" | "error" | "blocked" | "needs_review";
  txHash?: string;
  explorerUrl?: string;
  detail?: string;
  /** Wall-clock time this call spent in the pipeline, in ms — measured around the real work, never estimated. */
  durationMs: number;
}

/**
 * The actual compliance → risk → settlement pipeline for ONE payment.
 * Everything else in this file — single-recipient automations and Bulk
 * Payments alike — is just this function, called once or called N times.
 */
async function executeOnePayment(input: {
  merchantId: string; sender?: string | null; automationId: string; requestId: string;
  amount: number; token: string; tokenAddress?: string | null; tokenDecimals?: number | null;
  recipient: string; domain?: string | null;
  purpose?: string | null; memo?: string | null; fundingMode?: "wallet" | "reserved";
  executorAddress?: string | null; vaultAddress?: string | null;
  /** "automation" for a single-recipient run, "bulk" when this call is one
   *  recipient of a Bulk Payment occurrence — same pipeline either way, only
   *  the platform-metrics attribution differs. */
  feature: "automation" | "bulk";
}): Promise<ScheduleExecutionResult> {
  const { runValidation, assessRisk, execute } = await import("@/lib/payment/engine");
  const { recordTx } = await import("@/lib/platform/store");
  const startedAt = Date.now();

  const request: PaymentRequest = {
    action: "send_payment",
    amount: input.amount,
    token: input.token as PaymentRequest["token"],
    tokenAddress: input.tokenAddress,
    tokenDecimals: input.tokenDecimals,
    recipient: input.recipient,
    purpose: input.purpose ?? input.memo ?? "Payment Automation",
    network: "monad",
    requestId: input.requestId,
    fundingMode: input.fundingMode,
    fromWallet: input.sender,
    automationId: input.automationId,
    executorAddress: input.executorAddress,
    vaultAddress: input.vaultAddress,
  };

  const compliance = runValidation(request);
  const risk = assessRisk(request);
  request.riskScore = risk.score;

  if (compliance.status === "rejected" || risk.level === "high") {
    const decision = compliance.status === "rejected" ? "blocked" : "needs_review";
    await recordTx(input.merchantId, {
      decision: decision as "blocked" | "needs_review", action: "send_payment", feature: input.feature, amount: input.amount, token: input.token,
      recipient: input.recipient, domain: input.domain ?? null, riskScore: risk.score, compliance: compliance.status,
      sender: input.sender,
      summary: `Automation: ${input.amount} ${input.token} → ${input.domain ?? input.recipient}`,
    });
    return { outcome: decision, detail: compliance.summary, durationMs: Date.now() - startedAt };
  }

  const tx = await execute(request);
  const ok = tx.status === "settled";
  const outcome: ScheduleExecutionResult["outcome"] = ok ? "executed" : "error";
  await recordTx(input.merchantId, {
    decision: outcome, action: "send_payment", feature: input.feature, amount: input.amount, token: input.token,
    recipient: input.recipient, domain: input.domain ?? null, riskScore: risk.score, compliance: compliance.status,
    txHash: tx.txHash, explorerUrl: tx.explorerUrl,
    sender: input.sender,
    summary: `Automation: sent ${input.amount} ${input.token} → ${input.domain ?? input.recipient}`,
  });
  return { outcome, txHash: tx.txHash, explorerUrl: tx.explorerUrl, detail: tx.detail, durationMs: Date.now() - startedAt };
}

/**
 * Single-recipient path — unchanged behavior, now implemented as one call
 * to executeOnePayment. Does NOT advance nextRun or touch status — the
 * caller (recordRun) decides that.
 */
export async function executeScheduleNow(s: ScheduledPayment, requestId: string): Promise<ScheduleExecutionResult> {
  return executeOnePayment({
    merchantId: s.merchantId, sender: s.sender, automationId: s.id, requestId,
    amount: s.amount, token: s.token, tokenAddress: s.tokenAddress, tokenDecimals: s.tokenDecimals,
    recipient: s.recipient, domain: s.domain,
    purpose: s.purpose, memo: s.memo, fundingMode: s.fundingMode,
    executorAddress: s.executorAddress, vaultAddress: s.vaultAddress,
    feature: "automation",
  });
}

export interface BulkExecutionResult {
  /** Aggregate outcome for this occurrence: "executed" only if every
   *  recipient succeeded, "partial" if some did and some didn't, "error" if
   *  none did. Never summarized away — recipientResults below has the real
   *  per-recipient truth regardless of which aggregate this is. */
  outcome: "executed" | "partial" | "error";
  recipientResults: BulkRecipientResult[];
  /** Total wall-clock time across every recipient in this run, in ms. */
  durationMs: number;
}

/**
 * Bulk Payments — the SAME executeOnePayment pipeline, called once per
 * recipient with its own idempotency-scoped requestId (so a retry of the
 * batch can't double-pay one recipient while correctly retrying another
 * that failed). Recipients are settled sequentially, not in parallel — the
 * underlying agent-funded/wallet-pull paths share per-agent daily caps and
 * nonce/idempotency state that aren't safe to race against themselves.
 */
export async function executeBulkScheduleNow(s: ScheduledPayment, baseRequestId: string): Promise<BulkExecutionResult> {
  const recipients = s.recipients ?? [];
  const results: BulkRecipientResult[] = [];
  const batchStartedAt = Date.now();
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const requestId = `${baseRequestId}:r${i}`;
    const result = await executeOnePayment({
      merchantId: s.merchantId, sender: s.sender, automationId: s.id, requestId,
      amount: r.amount, token: s.token, tokenAddress: s.tokenAddress, tokenDecimals: s.tokenDecimals,
      recipient: r.address, domain: r.domain,
      purpose: s.purpose, memo: r.note ?? s.memo, fundingMode: s.fundingMode,
      executorAddress: s.executorAddress, vaultAddress: s.vaultAddress,
      feature: "bulk",
    });
    results.push({
      address: r.address, domain: r.domain, amount: r.amount,
      txHash: result.txHash, explorerUrl: result.explorerUrl,
      decision: result.outcome, detail: result.detail, durationMs: result.durationMs,
    });
  }
  const succeeded = results.filter((r) => r.decision === "executed").length;
  const outcome: BulkExecutionResult["outcome"] =
    succeeded === results.length ? "executed" : succeeded === 0 ? "error" : "partial";
  return { outcome, recipientResults: results, durationMs: Date.now() - batchStartedAt };
}
