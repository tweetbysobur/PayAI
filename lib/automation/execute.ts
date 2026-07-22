/**
 * The ONE place a Payment Automation actually settles a payment. Both the
 * cron batch runner (app/api/cron/run-schedules/route.ts) and a manual
 * "Execute Now" trigger (app/api/automations/route.ts PATCH) call this same
 * function — there is no second execution path. This is what "Automation
 * Templates use the existing engine, never a separate one" means in
 * practice: even a feature as different-feeling as "run this one now" is
 * still this exact code, just invoked once instead of in a due-schedules
 * loop.
 *
 * Server-only.
 */
import "server-only";
import type { PaymentRequest } from "@/lib/payment/types";
import type { ScheduledPayment } from "@/lib/platform/types";

export interface ScheduleExecutionResult {
  outcome: "executed" | "error" | "blocked" | "needs_review";
  txHash?: string;
  explorerUrl?: string;
  detail?: string;
}

/**
 * Runs the compliance → risk → settlement pipeline for one schedule and
 * records the outcome (run history + tx log), identical to what the cron
 * loop does per-iteration. Does NOT advance nextRun or touch status — the
 * caller decides that (recordRun already does it for the normal due-cycle
 * path; a manual "Execute Now" advances/records exactly the same way by
 * calling recordRun with this result).
 */
export async function executeScheduleNow(s: ScheduledPayment, requestId: string): Promise<ScheduleExecutionResult> {
  const { runValidation, assessRisk, execute } = await import("@/lib/payment/engine");
  const { recordTx } = await import("@/lib/platform/store");

  const request: PaymentRequest = {
    action: "send_payment",
    amount: s.amount,
    token: s.token as PaymentRequest["token"],
    recipient: s.recipient,
    purpose: s.purpose ?? s.memo ?? "Payment Automation",
    network: "monad",
    requestId,
    fundingMode: s.fundingMode,
    fromWallet: s.sender,
    automationId: s.id,
  };

  const compliance = runValidation(request);
  const risk = assessRisk(request);
  request.riskScore = risk.score;

  if (compliance.status === "rejected" || risk.level === "high") {
    const decision = compliance.status === "rejected" ? "blocked" : "needs_review";
    await recordTx(s.merchantId, {
      decision: decision as "blocked" | "needs_review", action: "send_payment", amount: s.amount, token: s.token,
      recipient: s.recipient, domain: s.domain ?? null, riskScore: risk.score, compliance: compliance.status,
      sender: s.sender,
      summary: `Automation: ${s.amount} ${s.token} → ${s.domain ?? s.recipient}`,
    });
    return { outcome: decision, detail: compliance.summary };
  }

  const tx = await execute(request);
  const ok = tx.status === "settled";
  const outcome: ScheduleExecutionResult["outcome"] = ok ? "executed" : "error";
  await recordTx(s.merchantId, {
    decision: outcome, action: "send_payment", amount: s.amount, token: s.token,
    recipient: s.recipient, domain: s.domain ?? null, riskScore: risk.score, compliance: compliance.status,
    txHash: tx.txHash, explorerUrl: tx.explorerUrl,
    sender: s.sender,
    summary: `Automation: sent ${s.amount} ${s.token} → ${s.domain ?? s.recipient}`,
  });
  return { outcome, txHash: tx.txHash, explorerUrl: tx.explorerUrl, detail: tx.detail };
}
