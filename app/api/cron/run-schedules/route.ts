import { NextRequest, NextResponse } from "next/server";
import type { PaymentRequest } from "@/lib/payment/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/run-schedules — fires every due payment automation through the
 * custodial agent path (the agent wallet signs via PaymentExecutor, bounded by
 * the on-chain per-tx + daily caps). Triggered by Vercel Cron.
 *
 * Auth: Vercel Cron attaches `Authorization: Bearer ${CRON_SECRET}`. We refuse
 * any request without it, so this can't be invoked to move funds by anyone but
 * the scheduler. Each run is idempotent on (scheduleId, dueSlot) at the app
 * layer and again on-chain via the PaymentExecutor requestId.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { dueSchedules, dueForReminder, markReminded, recordRun } = await import("@/lib/platform/schedules");
  const { runValidation, assessRisk, execute } = await import("@/lib/payment/engine");
  const { ensureSanctionsLoaded } = await import("@/lib/payment/sanctions");
  const { recordTx } = await import("@/lib/platform/store");

  // "Upcoming execution" reminders — anything due within the next 24h that
  // hasn't already been reminded for this specific occurrence. Runs before the
  // due-execution loop so a user is notified ahead of time, not just after.
  const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
  const upcoming = await dueForReminder(REMINDER_WINDOW_MS);
  for (const s of upcoming) {
    await markReminded(s.id);
  }

  // Warm the sanctions list once before screening this batch of due payments.
  await ensureSanctionsLoaded();
  const due = await dueSchedules();
  const results: { id: string; outcome: string; txHash?: string }[] = [];

  for (const s of due) {
    const dueSlot = s.nextRun;
    try {
      const request: PaymentRequest = {
        action: "send_payment",
        amount: s.amount,
        token: s.token as PaymentRequest["token"],
        recipient: s.recipient,
        purpose: s.purpose ?? s.memo ?? "Payment Automation",
        network: "monad",
        requestId: `sch:${s.id}:${dueSlot}`,
      };

      const compliance = runValidation(request);
      const risk = assessRisk(request);
      request.riskScore = risk.score;

      // Same execution gate as instant payments: reject on hard compliance
      // failure or high risk; record the outcome and advance so the schedule
      // doesn't get stuck retrying a permanently-blocked payment.
      if (compliance.status === "rejected" || risk.level === "high") {
        const decision = compliance.status === "rejected" ? "blocked" : "needs_review";
        await recordRun(s.id, { at: Date.now(), decision, detail: compliance.summary });
        await recordTx(s.merchantId, {
          decision: decision as "blocked" | "needs_review", action: "send_payment", amount: s.amount, token: s.token,
          recipient: s.recipient, domain: s.domain ?? null, riskScore: risk.score, compliance: compliance.status,
          summary: `Automation: ${s.amount} ${s.token} → ${s.domain ?? s.recipient}`,
        });
        results.push({ id: s.id, outcome: decision });
        continue;
      }

      const tx = await execute(request);
      const ok = tx.status === "settled";
      await recordRun(s.id, { at: Date.now(), decision: ok ? "executed" : "error", txHash: tx.txHash, explorerUrl: tx.explorerUrl, detail: tx.detail });
      await recordTx(s.merchantId, {
        decision: ok ? "executed" : "error", action: "send_payment", amount: s.amount, token: s.token,
        recipient: s.recipient, domain: s.domain ?? null, riskScore: risk.score, compliance: compliance.status,
        txHash: tx.txHash, explorerUrl: tx.explorerUrl,
        summary: `Automation: sent ${s.amount} ${s.token} → ${s.domain ?? s.recipient}`,
      });
      results.push({ id: s.id, outcome: ok ? "executed" : "error", txHash: tx.txHash });
    } catch (e) {
      // Never let one bad schedule abort the batch; record and advance.
      await recordRun(s.id, { at: Date.now(), decision: "error", detail: e instanceof Error ? e.message : "Execution error" });
      results.push({ id: s.id, outcome: "error" });
    }
  }

  return NextResponse.json({ ran: results.length, results });
}
