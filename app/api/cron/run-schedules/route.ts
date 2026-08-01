import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

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
  // Two accepted auth forms, both constant-time compared:
  //   1. `Authorization: Bearer <secret>` — used by Vercel Cron and any caller
  //      that can set headers.
  //   2. `?token=<secret>` query param — for external schedulers (cron-job.org)
  //      where a custom header is fiddly to configure. Same secret; slightly
  //      more log exposure, acceptable for a trigger that only fires already-due,
  //      already-authorized payments to pre-approved recipients (idempotent).
  const auth = req.headers.get("authorization");
  const token = new URL(req.url).searchParams.get("token");
  const headerOk = !!auth && !!secret && safeCompare(auth, `Bearer ${secret}`);
  const tokenOk = !!token && !!secret && safeCompare(token, secret);
  if (!secret || (!headerOk && !tokenOk)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { dueSchedules, dueForReminder, markReminded, markLowBalanceWarned, recordRun, getSchedule } = await import("@/lib/platform/schedules");
  const { executeScheduleNow, executeBulkScheduleNow } = await import("@/lib/automation/execute");
  const { checkFundingHealth } = await import("@/lib/automation/fundingHealth");
  const { ensureSanctionsLoaded } = await import("@/lib/payment/sanctions");
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

    // Funding-health check, same "once per occurrence" cadence as the
    // reminder above — a real on-chain balance/reservation read, not an
    // estimate. Best-effort: an RPC hiccup here must never block reminders
    // or the due-execution pass below.
    try {
      const kind: "wallet" | "reserved" | null = s.fundingMode === "reserved" ? "reserved" : s.fundingMode === "wallet" ? "wallet" : null;
      const alreadyWarned = kind === "wallet" ? s.lowBalanceWarnedForRun === s.nextRun : kind === "reserved" ? s.reservedLowWarnedForRun === s.nextRun : true;
      if (kind && !alreadyWarned) {
        const health = await checkFundingHealth(s);
        if (health && !health.sufficient) {
          const label = kind === "wallet" ? "wallet balance" : "reserved balance";
          await markLowBalanceWarned(
            s.id, kind,
            `Your ${label} (${health.available.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${s.token}) is below the ${health.needed.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${s.token} due at the next execution.`,
          );
        }
      }
    } catch (e) {
      trace("funding_health_check_error", { automationId: s.id, error: e instanceof Error ? e.message : String(e) });
    }
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

    // Re-check liveness against a fresh read, not the batch snapshot `s`.
    // `due` was fetched once at the top of this run; if a user cancels,
    // pauses, or deletes an automation in the seconds between that fetch and
    // this exact iteration, `s` still shows its old status and this loop
    // would otherwise execute a payment the user just told PayAI to stop.
    // The requestId claim above only guards against re-running the SAME
    // occurrence twice — it says nothing about whether the automation is
    // still supposed to run at all. Release rather than complete the claim,
    // since nothing was attempted: the next legitimate due occurrence (if
    // any) must not find a stale claim in its way.
    const fresh = await getSchedule(s.id);
    if (!fresh || (fresh.status !== "active" && fresh.status !== "scheduled")) {
      trace("skip_no_longer_live", { automationId: s.id, requestId, status: fresh?.status ?? "deleted" });
      await releaseRequest(requestId);
      continue;
    }

    try {
      const isBulk = !!s.recipients?.length;
      trace("attempt_start", { automationId: s.id, requestId, amount: s.amount, token: s.token, fundingMode: s.fundingMode ?? "agent", bulk: isBulk, recipientCount: s.recipients?.length });

      if (isBulk) {
        // Same per-recipient pipeline a single automation uses, just called
        // once per recipient — see lib/automation/execute.ts.
        const bulkResult = await executeBulkScheduleNow(s, requestId);
        await recordRun(s.id, { at: Date.now(), decision: bulkResult.outcome, recipientResults: bulkResult.recipientResults, durationMs: bulkResult.durationMs });
        await completeRequest(requestId, { outcome: bulkResult.outcome });
        trace("attempt_end", { automationId: s.id, requestId, outcome: bulkResult.outcome, recipientCount: bulkResult.recipientResults.length });
        results.push({ id: s.id, outcome: bulkResult.outcome });
        continue;
      }

      // Same execution the manual "Execute Now" action calls — see
      // lib/automation/execute.ts. One pipeline, two callers.
      const result = await executeScheduleNow(s, requestId);
      await recordRun(s.id, { at: Date.now(), decision: result.outcome, txHash: result.txHash, explorerUrl: result.explorerUrl, detail: result.detail, durationMs: result.durationMs });
      await completeRequest(requestId, { outcome: result.outcome, txHash: result.txHash });
      trace("attempt_end", { automationId: s.id, requestId, outcome: result.outcome, txHash: result.txHash });
      results.push({ id: s.id, outcome: result.outcome, txHash: result.txHash });
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

  // Retry any Reserved Funds refund that didn't land on its first (synchronous)
  // attempt — an RPC hiccup at the exact moment an automation went terminal
  // shouldn't leave money stuck with no automatic path back. Best-effort and
  // bounded: never let a refund retry block or fail this tick's real job of
  // executing due payments, which is why it's placed last.
  let refundsRetried = 0;
  try {
    const { retryPendingRefunds } = await import("@/lib/platform/schedules");
    refundsRetried = await retryPendingRefunds();
    if (refundsRetried > 0) trace("refund_retry_sweep", { refundsRetried });
  } catch (e) {
    trace("refund_retry_sweep_error", { error: e instanceof Error ? e.message : String(e) });
  }

  await recordHeartbeat({ startedAt, finishedAt: Date.now(), dueCount: due.length, processed: results.length });
  return NextResponse.json({ ran: results.length, results, refundsRetried });
}
