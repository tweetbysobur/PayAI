/**
 * Payment Automations store — one-off and recurring payments that fire
 * automatically when due, settled through the custodial agent path
 * (PaymentExecutor on Monad mainnet, with on-chain per-tx + daily caps).
 *
 * Three indexes, kept in lockstep by persist():
 *   1. A per-merchant hash — the dashboard's "my automations" view.
 *   2. A global hash mirror — the full record, fetchable by id from anywhere
 *      (the cron runner has no tenant context).
 *   3. A global sorted set scored by nextRun, containing ONLY automations
 *      currently eligible to fire ("active"/"scheduled"). This is what makes
 *      the cron's due-check a bounded range query instead of pulling every
 *      automation across every tenant into memory on every single tick —
 *      the latter doesn't scale past a few thousand records and only gets
 *      worse since nothing ever prunes completed/cancelled rows from a flat
 *      hash. The range query is defensive: if it ever throws (e.g. an
 *      unexpected KV response shape), it falls back to the old full-scan
 *      method rather than risking a missed or duplicated execution — a
 *      slower cron tick is an acceptable degradation; a silently-skipped
 *      payment automation is not.
 *
 * KV (Upstash) when configured, in-memory fallback for local dev — same seam
 * as store.ts.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";
import { recordAutomationEvent } from "./automationEvents";
import type { AutomationIntervalUnit, ScheduleCadence, ScheduledPayment, ScheduleStatus, ScheduleEndCondition } from "./types";

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function label(row: Pick<ScheduledPayment, "amount" | "token" | "domain" | "recipient">): string {
  return `${row.amount} ${row.token} → ${row.domain ?? short(row.recipient)}`;
}

const mKey = (m: string) => `veripay:${m}:schedules`;
const GLOBAL_KEY = "veripay:schedules:all";
const DUE_INDEX_KEY = "veripay:schedules:due-index";
const LIVE_STATUSES: ScheduleStatus[] = ["active", "scheduled"];

/** After this many consecutive execution errors, an automation auto-pauses to
 *  "failed" instead of retrying forever and quietly burning gas every tick. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** On a transient execution error, push the retry out instead of leaving
 *  nextRun in the past (which the cron would otherwise re-pick immediately,
 *  hammering an already-struggling RPC/signer on every tick). */
const RETRY_BACKOFF_MS = 15 * 60 * 1000;

const g = globalThis as unknown as { __veripaySchedules?: Map<string, ScheduledPayment> };
const mem = (g.__veripaySchedules ??= new Map());

/** Advance a recurring automation's next run; null for a fired one-off (it completes). */
export function advanceRun(from: number, cadence: ScheduleCadence, interval?: { count?: number; unit?: AutomationIntervalUnit }): number | null {
  const d = new Date(from);
  const count = Math.max(1, Math.floor(interval?.count ?? 1));
  switch (cadence) {
    case "daily": d.setUTCDate(d.getUTCDate() + 1); return d.getTime();
    case "weekly": d.setUTCDate(d.getUTCDate() + 7); return d.getTime();
    case "monthly": d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime();
    case "custom":
      if (interval?.unit === "weeks") d.setUTCDate(d.getUTCDate() + count * 7);
      else if (interval?.unit === "months") d.setUTCMonth(d.getUTCMonth() + count);
      else d.setUTCDate(d.getUTCDate() + count);
      return d.getTime();
    case "once": return null;
  }
}

export async function createSchedule(
  merchantId: string,
  input: {
    amount: number; token: string; tokenAddress?: string; tokenDecimals?: number; tokenLogo?: string | null;
    recipient: string; domain?: string | null;
    cadence: ScheduleCadence; nextRun: number; memo?: string; sender?: string | null;
    intervalCount?: number; intervalUnit?: AutomationIntervalUnit; timezone?: string; purpose?: string;
    signature?: string | null; signatureMessage?: string | null;
    endCondition?: ScheduleEndCondition;
    fundingMode?: "wallet" | "reserved"; reserveTxHash?: string | null;
    /** Reserved Funds only: a client-generated id the vault reservation was
     *  keyed to, so the on-chain reservation and the stored record share one id. */
    id?: string;
    templateId?: string | null; templateCategory?: string | null;
    recipients?: import("./types").BulkRecipient[];
    distributionMethod?: import("./types").DistributionMethod;
  },
): Promise<ScheduledPayment> {
  const row: ScheduledPayment = {
    id: input.id && /^sch_[a-zA-Z0-9-]{8,}$/.test(input.id) ? input.id : `sch_${crypto.randomUUID()}`,
    merchantId,
    sender: input.sender ?? null,
    amount: input.amount,
    token: input.token,
    tokenAddress: input.tokenAddress,
    tokenDecimals: input.tokenDecimals,
    tokenLogo: input.tokenLogo ?? null,
    recipient: input.recipient,
    domain: input.domain ?? null,
    cadence: input.cadence,
    intervalCount: input.cadence === "custom" ? Math.max(1, Math.floor(input.intervalCount ?? 1)) : undefined,
    intervalUnit: input.cadence === "custom" ? input.intervalUnit ?? "days" : undefined,
    timezone: input.timezone ?? "Africa/Lagos",
    purpose: input.purpose?.trim() || input.memo?.trim() || "Other",
    nextRun: input.nextRun,
    status: "active",
    createdAt: Date.now(),
    runs: [],
    memo: input.memo,
    endCondition: input.endCondition ?? { type: "never" },
    runsCompleted: 0,
    failureCount: 0,
    lastError: null,
    signature: input.signature ?? null,
    signatureMessage: input.signatureMessage ?? null,
    modifiedAt: null,
    fundingMode: input.fundingMode ?? "wallet",
    reserveTxHash: input.reserveTxHash ?? null,
    remindedForRun: null,
    lowBalanceWarnedForRun: null,
    reservedLowWarnedForRun: null,
    templateId: input.templateId ?? null,
    templateCategory: input.templateCategory ?? null,
    recipients: input.recipients,
    distributionMethod: input.distributionMethod,
  };
  await persist(row);
  await recordAutomationEvent({
    merchantId, automationId: row.id, sender: row.sender, type: "created",
    title: "Automation created", detail: `${label(row)} — ${row.cadence}, next run ${new Date(row.nextRun).toLocaleString()}.`,
    amount: row.amount, token: row.token,
  });
  return row;
}

/** Edit an automation's terms. Only fields the caller actually passes
 *  are changed; editing never touches history (`runs`) or counters. Ownership
 *  is enforced the same way as cancelSchedule. Returns null if not found, not
 *  owned by `sender` (on the shared tenant), or no longer editable — you can't
 *  edit an automation that already completed, failed, or was cancelled. */
export async function updateSchedule(
  merchantId: string,
  id: string,
  patch: Partial<Pick<ScheduledPayment, "amount" | "cadence" | "nextRun" | "memo" | "endCondition" | "purpose" | "timezone" | "intervalCount" | "intervalUnit" | "modifiedAt">>,
  opts?: { sender?: string | null },
): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row || row.merchantId !== merchantId || (row.status !== "active" && row.status !== "scheduled" && row.status !== "paused")) return null;
  const sender = opts?.sender?.trim().toLowerCase();
  if (sender && (row.sender ?? "").toLowerCase() !== sender) return null;
  Object.assign(row, patch);
  await persist(row);
  return row;
}

async function persist(row: ScheduledPayment): Promise<void> {
  const r = await getRedis();
  if (r) {
    await r.hset(mKey(row.merchantId), { [row.id]: row });
    await r.hset(GLOBAL_KEY, { [row.id]: row });
    // Keep the due-index in sync at the one place every mutator already goes
    // through: live (active/scheduled) → indexed by nextRun; anything else
    // (paused/completed/cancelled/failed) → removed so it's never scanned
    // again. Defensive: an index-sync failure must never block the write
    // that actually matters (the record itself already persisted above).
    try {
      if (LIVE_STATUSES.includes(row.status)) {
        await r.zadd(DUE_INDEX_KEY, { score: row.nextRun, member: row.id });
      } else {
        await r.zrem(DUE_INDEX_KEY, row.id);
      }
    } catch {
      /* the full-scan fallback in dueSchedules/dueForReminder covers this */
    }
  } else {
    mem.set(row.id, row);
  }
}

export async function listSchedules(merchantId: string, opts?: { sender?: string | null }): Promise<ScheduledPayment[]> {
  const r = await getRedis();
  let rows: ScheduledPayment[];
  if (r) {
    const h = (await r.hgetall(mKey(merchantId))) ?? {};
    rows = Object.values(h) as ScheduledPayment[];
  } else {
    rows = [...mem.values()].filter((s) => s.merchantId === merchantId);
  }
  // When a wallet is given, return ONLY that wallet's own automations — this is
  // what keeps one wallet-only user's recurring payments private from every
  // other wallet-only user sharing the same demo tenant.
  const sender = opts?.sender?.trim().toLowerCase();
  if (sender) rows = rows.filter((s: ScheduledPayment) => (s.sender ?? "").toLowerCase() === sender);
  // Upcoming first (soonest next-run), then completed/cancelled by recency.
  return rows.sort((a, b) => {
    const aLive = a.status === "active" || a.status === "scheduled" || a.status === "executing";
    const bLive = b.status === "active" || b.status === "scheduled" || b.status === "executing";
    if (aLive && bLive) return a.nextRun - b.nextRun;
    if (aLive) return -1;
    if (bLive) return 1;
    return b.createdAt - a.createdAt;
  });
}

export async function cancelSchedule(merchantId: string, id: string, opts?: { sender?: string | null }): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row || row.merchantId !== merchantId) return null;
  // On the shared demo tenant, also require the caller's wallet to be the
  // automation's own creator — otherwise any wallet-only user could cancel
  // another user's real automation just by knowing/guessing its id.
  const sender = opts?.sender?.trim().toLowerCase();
  if (sender && (row.sender ?? "").toLowerCase() !== sender) return null;
  const wasLive = row.status === "active" || row.status === "scheduled" || row.status === "paused" || row.status === "failed";
  if (wasLive) row.status = "cancelled";
  await persist(row);
  if (wasLive) {
    await recordAutomationEvent({
      merchantId, automationId: row.id, sender: row.sender, type: "cancelled",
      title: "Automation cancelled", detail: `${label(row)} will no longer run.`,
      amount: row.amount, token: row.token,
    });
  }
  return row;
}

export async function setScheduleStatus(
  merchantId: string,
  id: string,
  status: Extract<ScheduleStatus, "active" | "paused" | "cancelled">,
  opts?: { sender?: string | null },
): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row || row.merchantId !== merchantId) return null;
  const sender = opts?.sender?.trim().toLowerCase();
  if (sender && (row.sender ?? "").toLowerCase() !== sender) return null;
  if (row.status === "completed") return null;
  const wasPaused = row.status === "paused" || row.status === "failed";
  row.status = status;
  // Resuming re-arms the automation cleanly: clear the failure trail so it
  // isn't one error away from immediately auto-pausing again, and give it a
  // fresh due time rather than firing on whatever stale nextRun it paused at.
  if (status === "active" && wasPaused) {
    row.failureCount = 0;
    row.lastError = null;
    if (row.nextRun < Date.now()) row.nextRun = Date.now();
  }
  await persist(row);
  if (status === "paused" && !wasPaused) {
    await recordAutomationEvent({
      merchantId, automationId: row.id, sender: row.sender, type: "paused",
      title: "Automation paused", detail: `${label(row)} won't run until you resume it.`,
      amount: row.amount, token: row.token,
    });
  } else if (status === "active" && wasPaused) {
    await recordAutomationEvent({
      merchantId, automationId: row.id, sender: row.sender, type: "resumed",
      title: "Automation resumed", detail: `${label(row)} — next run ${new Date(row.nextRun).toLocaleString()}.`,
      amount: row.amount, token: row.token,
    });
  } else if (status === "cancelled") {
    await recordAutomationEvent({
      merchantId, automationId: row.id, sender: row.sender, type: "cancelled",
      title: "Automation cancelled", detail: `${label(row)} will no longer run.`,
      amount: row.amount, token: row.token,
    });
  }
  return row;
}

export async function deleteSchedule(merchantId: string, id: string, opts?: { sender?: string | null }): Promise<boolean> {
  const row = await getSchedule(id);
  if (!row || row.merchantId !== merchantId) return false;
  const sender = opts?.sender?.trim().toLowerCase();
  if (sender && (row.sender ?? "").toLowerCase() !== sender) return false;
  const r = await getRedis();
  if (r) {
    const client = r as unknown as { hdel?: (key: string, field: string) => Promise<unknown> };
    await client.hdel?.(mKey(row.merchantId), row.id);
    await client.hdel?.(GLOBAL_KEY, row.id);
  } else {
    mem.delete(row.id);
  }
  return true;
}

export async function getSchedule(id: string): Promise<ScheduledPayment | null> {
  const r = await getRedis();
  if (r) {
    const v = await r.hget(GLOBAL_KEY, id);
    return (v as ScheduledPayment) ?? null;
  }
  return mem.get(id) ?? null;
}

/** Full-scan fallback — correct but O(total automations across every
 *  tenant), used only when the sorted-set index is unavailable or errors. */
async function scanAll(): Promise<ScheduledPayment[]> {
  const r = await getRedis();
  if (r) {
    const h = (await r.hgetall(GLOBAL_KEY)) ?? {};
    return Object.values(h) as ScheduledPayment[];
  }
  return [...mem.values()];
}

/** Fetch full records for a batch of ids from the global hash. */
async function fetchByIds(r: NonNullable<Awaited<ReturnType<typeof getRedis>>>, ids: string[]): Promise<ScheduledPayment[]> {
  const rows = await Promise.all(ids.map((id) => r.hget(GLOBAL_KEY, id)));
  return rows.filter((v): v is ScheduledPayment => v != null) as ScheduledPayment[];
}

/** Every active automation whose nextRun is at or before `now` — the cron's
 *  work queue. Uses the nextRun-scored index (bounded range query) so this
 *  scales with the number of DUE automations, not the total ever created. */
export async function dueSchedules(now: number = Date.now()): Promise<ScheduledPayment[]> {
  const r = await getRedis();
  if (r) {
    try {
      const ids = await r.zrange(DUE_INDEX_KEY, 0, now, { byScore: true });
      return await fetchByIds(r, ids);
    } catch {
      /* index unavailable or malformed — fall through to the full scan below */
    }
  }
  const rows = await scanAll();
  return rows.filter((s) => LIVE_STATUSES.includes(s.status) && s.nextRun <= now);
}

/** Every active automation whose nextRun falls within the lookahead window and
 *  hasn't already been reminded for that specific occurrence — the cron's
 *  "upcoming execution" notification queue. Same indexed range query as
 *  dueSchedules(), just bounded on both ends instead of one. */
export async function dueForReminder(windowMs: number, now: number = Date.now()): Promise<ScheduledPayment[]> {
  const r = await getRedis();
  if (r) {
    try {
      const ids = await r.zrange(DUE_INDEX_KEY, now, now + windowMs, { byScore: true });
      const rows = await fetchByIds(r, ids);
      return rows.filter((s) => s.remindedForRun !== s.nextRun);
    } catch {
      /* fall through to the full scan below */
    }
  }
  const rows = await scanAll();
  return rows.filter((s) =>
    LIVE_STATUSES.includes(s.status) &&
    s.nextRun > now && s.nextRun <= now + windowMs &&
    s.remindedForRun !== s.nextRun,
  );
}

/** Mark that an "upcoming execution" reminder has been sent for the automation's
 *  CURRENT nextRun — idempotent per occurrence so a 15-minute cron cadence
 *  doesn't spam the same reminder on every tick within the lookahead window. */
export async function markReminded(id: string): Promise<void> {
  const row = await getSchedule(id);
  if (!row) return;
  row.remindedForRun = row.nextRun;
  await persist(row);
  await recordAutomationEvent({
    merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "upcoming_execution",
    title: "Upcoming execution", detail: `${label(row)} runs ${new Date(row.nextRun).toLocaleString()}.`,
    amount: row.amount, token: row.token,
  });
}

/** Same idempotent-per-occurrence pattern as markReminded, for the two
 *  funding-health warnings (Wallet Automation balance / Reserved Funds
 *  reservation) — fires at most once per nextRun, not once per cron tick. */
export async function markLowBalanceWarned(id: string, kind: "wallet" | "reserved", detail: string): Promise<void> {
  const row = await getSchedule(id);
  if (!row) return;
  if (kind === "wallet") row.lowBalanceWarnedForRun = row.nextRun;
  else row.reservedLowWarnedForRun = row.nextRun;
  await persist(row);
  await recordAutomationEvent({
    merchantId: row.merchantId, automationId: row.id, sender: row.sender,
    type: kind === "wallet" ? "low_balance" : "reserved_funds_low",
    title: kind === "wallet" ? "Low balance" : "Reserved funds running low",
    detail, amount: row.amount, token: row.token,
  });
}

/**
 * Record a fired run and decide what happens next — this is the single most
 * important reliability decision in the whole feature, because it used to
 * advance to the next period unconditionally regardless of whether the
 * payment actually happened. That meant a transient RPC error or a compliance
 * block silently consumed that occurrence forever: the automation moved on as
 * if it had paid, with no retry and no clear signal to the user that a
 * payment they were relying on never went out.
 *
 * Now: only a genuine "executed" run advances the schedule. A hard compliance
 * block (or needs_review — there's no manual-review UI for an automation, so
 * retrying it unattended would just block again) is TERMINAL: mark "failed"
 * immediately rather than pretending it will resolve itself. An execution
 * error (RPC hiccup, agent-wallet balance, etc.) is treated as transient: the
 * same occurrence is retried after a backoff, up to MAX_CONSECUTIVE_FAILURES,
 * after which the automation auto-pauses to "failed" instead of hammering a
 * broken path forever.
 */
export async function recordRun(
  id: string,
  run: { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string; durationMs?: number; recipientResults?: import("./types").BulkRecipientResult[] },
): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row) return null;
  row.runs = [run, ...row.runs].slice(0, 50);
  let justPaused = false;
  const isBulk = !!row.recipients?.length;

  // Bulk: "partial" (some recipients paid, some didn't) still advances the
  // schedule to its next occurrence — the occurrence genuinely happened,
  // just not perfectly. Failed recipients are visible in recipientResults
  // and can be retried individually via "Execute Now" on this automation;
  // there is no automatic per-recipient retry.
  if (run.decision === "executed" || run.decision === "partial") {
    row.failureCount = 0;
    row.lastError = run.decision === "partial" ? (run.detail ?? "Some recipients could not be paid.") : null;
    row.runsCompleted += 1;
    const endCondition = row.endCondition ?? { type: "never" };
    const nextByCadence = advanceRun(row.nextRun, row.cadence, { count: row.intervalCount, unit: row.intervalUnit });
    const endedByCount = endCondition.type === "after_count" && row.runsCompleted >= endCondition.totalRuns;
    const endedByDate = endCondition.type === "until_date" && nextByCadence != null && nextByCadence > endCondition.untilMs;
    if (nextByCadence == null || endedByCount || endedByDate) {
      row.status = "completed" as ScheduleStatus;
    } else {
      row.nextRun = nextByCadence;
      // New occurrence — eligible for its own reminder and funding-health warnings.
      row.remindedForRun = null;
      row.lowBalanceWarnedForRun = null;
      row.reservedLowWarnedForRun = null;
    }
  } else if (run.decision === "blocked" || run.decision === "needs_review") {
    // A hard compliance outcome won't spontaneously clear on an unattended
    // retry — stop cleanly and say so, instead of silently skipping forever.
    row.status = "failed" as ScheduleStatus;
    row.lastError = run.detail ?? "Blocked by compliance.";
    justPaused = true;
  } else {
    // Execution error — assume transient, retry the SAME occurrence after a
    // backoff rather than advancing past it or hammering immediately.
    row.failureCount += 1;
    row.lastError = run.detail ?? "Execution failed.";
    if (row.failureCount >= MAX_CONSECUTIVE_FAILURES) {
      row.status = "failed" as ScheduleStatus;
      justPaused = true;
    } else {
      row.nextRun = Date.now() + RETRY_BACKOFF_MS;
    }
  }

  await persist(row);

  if (run.decision === "executed") {
    const succeeded = run.recipientResults?.filter((r) => r.decision === "executed").length ?? null;
    await recordAutomationEvent({
      merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "executed",
      title: isBulk ? "Distribution completed" : "Payment sent",
      detail: isBulk ? `All ${succeeded ?? row.recipients!.length} recipients were paid successfully.` : `${label(row)} settled successfully.`,
      amount: row.amount, token: row.token, txHash: run.txHash, explorerUrl: run.explorerUrl,
    });
    // The run above may have been the LAST one (end condition reached, or a
    // "once" cadence with no next occurrence) — status was already flipped
    // to "completed" earlier in this function. A separate, distinct
    // notification from "payment sent" so the user knows the whole
    // automation is done, not just that one more payment went through.
    if (row.status === "completed") {
      await recordAutomationEvent({
        merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "completed",
        title: "Automation completed",
        detail: isBulk ? `This distribution has finished its full schedule.` : `${label(row)} has finished its full schedule.`,
        amount: row.amount, token: row.token,
      });
    }
  } else if (run.decision === "partial") {
    const total = run.recipientResults?.length ?? 0;
    const failed = run.recipientResults?.filter((r) => r.decision !== "executed") ?? [];
    // Covers "Individual Payment Failed" as one aggregated notification per
    // batch rather than one per failed recipient — a large distribution
    // with several failures would otherwise flood the notification feed.
    // Every individual failure is still visible in the run's recipientResults
    // (Execution Logs), just not as its own separate push notification.
    await recordAutomationEvent({
      merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "execution_failed",
      title: "Some payments failed",
      detail: `${total - failed.length} of ${total} payments sent. ${failed.length} failed: ${failed.slice(0, 3).map((f) => f.domain ?? f.address).join(", ")}${failed.length > 3 ? "…" : ""}`,
      amount: row.amount, token: row.token,
    });
  } else {
    await recordAutomationEvent({
      merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "execution_failed",
      title: isBulk ? "Distribution failed" : "Execution failed",
      detail: run.detail ?? (isBulk ? "None of the recipients could be paid this time." : `${label(row)} could not be sent this time.`),
      amount: row.amount, token: row.token,
    });
    if (justPaused) {
      await recordAutomationEvent({
        merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "paused",
        title: "Automation paused", detail: `${label(row)} was paused — ${row.lastError ?? "repeated failures"}. Resume it once resolved.`,
        amount: row.amount, token: row.token,
      });
    }
  }

  return row;
}

/**
 * Advance past the current due occurrence WITHOUT executing it — no payment
 * attempt, no compliance/risk check, no on-chain call. Uses the exact same
 * advanceRun()/end-condition logic recordRun()'s "executed" branch uses, so
 * "skip" and "actually ran" always agree on what the next occurrence even
 * means; this only differs in that nothing was actually paid.
 */
export async function skipNextRun(merchantId: string, id: string, opts?: { sender?: string | null }): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row || row.merchantId !== merchantId) return null;
  if (opts?.sender && (row.sender ?? "").toLowerCase() !== opts.sender.toLowerCase()) return null;
  if (row.status !== "active" && row.status !== "scheduled") return null;

  const endCondition = row.endCondition ?? { type: "never" };
  const nextByCadence = advanceRun(row.nextRun, row.cadence, { count: row.intervalCount, unit: row.intervalUnit });
  const endedByCount = endCondition.type === "after_count" && row.runsCompleted >= endCondition.totalRuns;
  const endedByDate = endCondition.type === "until_date" && nextByCadence != null && nextByCadence > endCondition.untilMs;
  const skippedRun = { at: Date.now(), decision: "skipped", detail: "Skipped by the owner — no payment was sent for this occurrence." };
  row.runs = [skippedRun, ...row.runs].slice(0, 50);

  if (nextByCadence == null || endedByCount || endedByDate) {
    row.status = "completed" as ScheduleStatus;
  } else {
    row.nextRun = nextByCadence;
    row.remindedForRun = null;
    row.lowBalanceWarnedForRun = null;
    row.reservedLowWarnedForRun = null;
  }
  await persist(row);
  await recordAutomationEvent({
    merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "skipped",
    title: "Execution skipped", detail: `${label(row)}'s next scheduled run was skipped — no payment was sent.`,
    amount: row.amount, token: row.token,
  });
  return row;
}
