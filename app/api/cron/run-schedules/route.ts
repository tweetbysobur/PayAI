import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import type { PaymentRequest } from "@/lib/payment/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One structured line per execution-lifecycle event — greppable by requestId
 *  or automationId in server logs, independent of the KV-backed history. This
 *  is the trace an on-call engineer reaches for when a user reports "did my
 *  payment go out?" and the dashboard alone isn't enough to reconstruct why. */
function trace(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "info", kind: "automation_execution", event, at: Date.now(), ...fields }));
}

/**
 * GET /api/cron/run-schedules — fires every due payment automation through the
 * custodial agent path (the agent wallet signs via PaymentExecutor, bounded by
 * the on-chain per-tx + daily caps). Triggered by Vercel Cron.
 *
 * Auth: Vercel Cron attaches `Authorization: Bearer ${CRON_SECRET}`. We refuse
 * any request without it, so this can't be invoked to move funds by anyone but
 * the scheduler.
 *
 * Duplicate-processing protection is two-layered, and BOTH layers are real:
 *   1. App layer — each occurrence claims a deterministic requestId
 *      (`sch:{scheduleId}:{dueSlot}`) via the same idempotency primitive used
 *      everywhere else in the app (lib/platform/idempotency.ts) BEFORE calling
 *      execute(). Vercel Cron does not guarantee exactly-once delivery, and a
 *      slow batch can brush against maxDuration — without this claim, a
 *      retried/overlapping invocation would call execute() a second time for
 *      the same occurrence. The on-chain contract would still reject the
 *      second transfer (funds are never double-spent), but the app would
 *      record a false "execution failed" on top of a real success and confuse
 *      the user. Claiming first makes the second invocation replay the first
 *      one's actual outcome instead of re-attempting or misreporting it.
 *   2. Chain layer — PaymentExecutor's on-chain requestId check, the
 *      backstop that holds even if the KV-backed claim above is ever
 *      unavailable (cold start, KV outage).
 */
/** Constant-time bearer-token compare — a plain `!==` leaks timing
 *  information proportional to the matching prefix length. Cheap to fix,
 *  no reason not to for the one endpoint that can trigger real fund movement. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || !auth || !safeCompare(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { dueSchedules, dueForReminder, markReminded, recordRun } = await import("@/lib/platform/schedules");
  const { runValidation, assessRisk, execute } = await import("@/lib/payment/engine");
  const { ensureSanctionsLoaded } = await import("@/lib/payment/sanctions");
  const { recordTx } = await import("@/lib/platform/store");
  const { claimRequest, completeRequest, releaseRequest } = await import("@/lib/platform/idempotency");
  const { recordHeartbeat } = await import("@/lib/platform/cronHealth");
  const startedAt = Date.now();

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
  trace("batch_start", { dueCount: due.length, remindedCount: upcoming.length });

  // Soft time budget under Vercel's hard 60s (maxDuration) limit. If the
  // platform kills this function mid-execute(), whichever automation was
  // in-flight is left with a stuck "in_progress" claim until its 24h TTL
  // expires — a full day of unintended delay for that one automation. This
  // check only ever stops the batch from STARTING a new automation once
  // time is tight; it can't do anything about a single execute() call itself
  // running long, but it eliminates the far more likely failure mode of
  // simply having more due automations than one tick has time for. Anything
  // left over stays due and is picked up on the next tick.
  const BATCH_DEADLINE_MS = 50_000;
  const batchStart = Date.now();

  for (const s of due) {
    if (Date.now() - batchStart > BATCH_DEADLINE_MS) {
      trace("batch_truncated", { remaining: due.length - results.length, reason: "time_budget" });
      break;
    }
    const dueSlot = s.nextRun;
    const requestId = `sch:${s.id}:${dueSlot}`;

    // Claim this exact occurrence before doing anything else. If a concurrent
    // or retried invocation already claimed it, replay its result instead of
    // running the pipeline (and possibly execute()) a second time — see the
    // duplicate-processing note above the handler.
    const claim = await claimRequest<{ outcome: string; txHash?: string }>(requestId);
    if (!claim.claimed) {
      trace("skip_duplicate", { automationId: s.id, requestId, status: claim.status });
      if (claim.status === "done" && claim.result) results.push({ id: s.id, ...claim.result });
      continue;
    }

    try {
      const request: PaymentRequest = {
        action: "send_payment",
        amount: s.amount,
        token: s.token as PaymentRequest["token"],
        recipient: s.recipient,
        purpose: s.purpose ?? s.memo ?? "Payment Automation",
        network: "monad",
        requestId,
        // Route to the funding path the user chose at creation. Legacy records
        // (no fundingMode) fall through to the agent-funded path unchanged.
        fundingMode: s.fundingMode,
        fromWallet: s.sender,
        automationId: s.id,
      };
      trace("attempt_start", { automationId: s.id, requestId, amount: s.amount, token: s.token, fundingMode: s.fundingMode ?? "agent" });

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
        await completeRequest(requestId, { outcome: decision });
        trace("attempt_end", { automationId: s.id, requestId, outcome: decision });
        results.push({ id: s.id, outcome: decision });
        continue;
      }

      const tx = await execute(request);
      const ok = tx.status === "settled";
      const outcome = ok ? "executed" : "error";
      await recordRun(s.id, { at: Date.now(), decision: outcome, txHash: tx.txHash, explorerUrl: tx.explorerUrl, detail: tx.detail });
      await recordTx(s.merchantId, {
        decision: outcome, action: "send_payment", amount: s.amount, token: s.token,
        recipient: s.recipient, domain: s.domain ?? null, riskScore: risk.score, compliance: compliance.status,
        txHash: tx.txHash, explorerUrl: tx.explorerUrl,
        summary: `Automation: sent ${s.amount} ${s.token} → ${s.domain ?? s.recipient}`,
      });
      await completeRequest(requestId, { outcome, txHash: tx.txHash });
      trace("attempt_end", { automationId: s.id, requestId, outcome, txHash: tx.txHash });
      results.push({ id: s.id, outcome, txHash: tx.txHash });
    } catch (e) {
      // Never let one bad schedule abort the batch; record and advance.
      const detail = e instanceof Error ? e.message : "Execution error";
      await recordRun(s.id, { at: Date.now(), decision: "error", detail });
      // Release rather than complete: this attempt never reached a real
      // outcome, so the NEXT cron tick (after the automation's own retry
      // backoff advances nextRun/requestId) must be free to try again rather
      // than finding a stale "in_progress" claim sitting in its way.
      await releaseRequest(requestId);
      trace("attempt_error", { automationId: s.id, requestId, error: detail });
      results.push({ id: s.id, outcome: "error" });
    }
  }

  trace("batch_end", { processed: results.length });
  await recordHeartbeat({ startedAt, finishedAt: Date.now(), dueCount: due.length, processed: results.length });
  return NextResponse.json({ ran: results.length, results });
}
