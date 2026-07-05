/**
 * Scheduled payments store — one-off and recurring payments that fire
 * automatically when due, settled through the custodial agent path
 * (PaymentExecutor on Monad mainnet, with on-chain per-tx + daily caps).
 *
 * Two indexes are kept in lockstep: a per-merchant hash (for the dashboard's
 * "my schedules" view) and a global hash mirror (for the cron runner, which
 * has no tenant context and must scan every merchant's due schedules). KV when
 * configured, in-memory fallback for local dev — same seam as store.ts.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";
import type { ScheduleCadence, ScheduledPayment, ScheduleStatus, ScheduleEndCondition } from "./types";

const mKey = (m: string) => `veripay:${m}:schedules`;
const GLOBAL_KEY = "veripay:schedules:all";

/** After this many consecutive execution errors, a schedule auto-pauses to
 *  "failed" instead of retrying forever and quietly burning gas every tick. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** On a transient execution error, push the retry out instead of leaving
 *  nextRun in the past (which the cron would otherwise re-pick immediately,
 *  hammering an already-struggling RPC/signer on every tick). */
const RETRY_BACKOFF_MS = 15 * 60 * 1000;

const g = globalThis as unknown as { __veripaySchedules?: Map<string, ScheduledPayment> };
const mem = (g.__veripaySchedules ??= new Map());

/** Advance a recurring schedule's next run; null for a fired one-off (it completes). */
export function advanceRun(from: number, cadence: ScheduleCadence): number | null {
  const d = new Date(from);
  switch (cadence) {
    case "daily": d.setUTCDate(d.getUTCDate() + 1); return d.getTime();
    case "weekly": d.setUTCDate(d.getUTCDate() + 7); return d.getTime();
    case "monthly": d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime();
    case "once": return null;
  }
}

export async function createSchedule(
  merchantId: string,
  input: {
    amount: number; token: string; recipient: string; domain?: string | null;
    cadence: ScheduleCadence; nextRun: number; memo?: string; sender?: string | null;
    endCondition?: ScheduleEndCondition;
  },
): Promise<ScheduledPayment> {
  const row: ScheduledPayment = {
    id: `sch_${crypto.randomUUID()}`,
    merchantId,
    sender: input.sender ?? null,
    amount: input.amount,
    token: input.token,
    recipient: input.recipient,
    domain: input.domain ?? null,
    cadence: input.cadence,
    nextRun: input.nextRun,
    status: "upcoming",
    createdAt: Date.now(),
    runs: [],
    memo: input.memo,
    endCondition: input.endCondition ?? { type: "never" },
    runsCompleted: 0,
    failureCount: 0,
    lastError: null,
  };
  await persist(row);
  return row;
}

/** Edit an upcoming schedule's terms. Only fields the caller actually passes
 *  are changed; editing never touches history (`runs`) or counters. Ownership
 *  is enforced the same way as cancelSchedule. Returns null if not found, not
 *  owned by `sender` (on the shared tenant), or no longer upcoming — you can't
 *  edit a schedule that already completed, failed, or was cancelled. */
export async function updateSchedule(
  merchantId: string,
  id: string,
  patch: Partial<Pick<ScheduledPayment, "amount" | "cadence" | "nextRun" | "memo" | "endCondition">>,
  opts?: { sender?: string | null },
): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row || row.merchantId !== merchantId || row.status !== "upcoming") return null;
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
  // When a wallet is given, return ONLY that wallet's own schedules — this is
  // what keeps one wallet-only user's recurring payments private from every
  // other wallet-only user sharing the same demo tenant.
  const sender = opts?.sender?.trim().toLowerCase();
  if (sender) rows = rows.filter((s: ScheduledPayment) => (s.sender ?? "").toLowerCase() === sender);
  // Upcoming first (soonest next-run), then completed/cancelled by recency.
  return rows.sort((a, b) => {
    if (a.status === "upcoming" && b.status === "upcoming") return a.nextRun - b.nextRun;
    if (a.status === "upcoming") return -1;
    if (b.status === "upcoming") return 1;
    return b.createdAt - a.createdAt;
  });
}

export async function cancelSchedule(merchantId: string, id: string, opts?: { sender?: string | null }): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row || row.merchantId !== merchantId) return null;
  // On the shared demo tenant, also require the caller's wallet to be the
  // schedule's own creator — otherwise any wallet-only user could cancel
  // another user's real scheduled payment just by knowing/guessing its id.
  const sender = opts?.sender?.trim().toLowerCase();
  if (sender && (row.sender ?? "").toLowerCase() !== sender) return null;
  if (row.status === "upcoming") row.status = "cancelled";
  await persist(row);
  return row;
}

export async function getSchedule(id: string): Promise<ScheduledPayment | null> {
  const r = await getRedis();
  if (r) {
    const v = await r.hget(GLOBAL_KEY, id);
    return (v as ScheduledPayment) ?? null;
  }
  return mem.get(id) ?? null;
}

/** Every upcoming schedule whose nextRun is at or before `now` — the cron's work queue. */
export async function dueSchedules(now: number = Date.now()): Promise<ScheduledPayment[]> {
  const r = await getRedis();
  let rows: ScheduledPayment[];
  if (r) {
    const h = (await r.hgetall(GLOBAL_KEY)) ?? {};
    rows = Object.values(h) as ScheduledPayment[];
  } else {
    rows = [...mem.values()];
  }
  return rows.filter((s) => s.status === "upcoming" && s.nextRun <= now);
}

/**
 * Record a fired run and decide what happens next — this is the single most
 * important reliability decision in the whole feature, because it used to
 * advance to the next period unconditionally regardless of whether the
 * payment actually happened. That meant a transient RPC error or a compliance
 * block silently consumed that occurrence forever: the schedule moved on as
 * if it had paid, with no retry and no clear signal to the user that a
 * payment they were relying on never went out.
 *
 * Now: only a genuine "executed" run advances the schedule. A hard compliance
 * block (or needs_review — there's no manual-review UI for a schedule, so
 * retrying it unattended would just block again) is TERMINAL: mark "failed"
 * immediately rather than pretending it will resolve itself. An execution
 * error (RPC hiccup, agent-wallet balance, etc.) is treated as transient: the
 * same occurrence is retried after a backoff, up to MAX_CONSECUTIVE_FAILURES,
 * after which the schedule auto-pauses to "failed" instead of hammering a
 * broken path forever.
 */
export async function recordRun(
  id: string,
  run: { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string },
): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row) return null;
  row.runs = [run, ...row.runs].slice(0, 50);

  if (run.decision === "executed") {
    row.failureCount = 0;
    row.lastError = null;
    row.runsCompleted += 1;
    const endCondition = row.endCondition ?? { type: "never" };
    const nextByCadence = advanceRun(row.nextRun, row.cadence);
    const endedByCount = endCondition.type === "after_count" && row.runsCompleted >= endCondition.totalRuns;
    const endedByDate = endCondition.type === "until_date" && nextByCadence != null && nextByCadence > endCondition.untilMs;
    if (nextByCadence == null || endedByCount || endedByDate) {
      row.status = "completed" as ScheduleStatus;
    } else {
      row.nextRun = nextByCadence;
    }
  } else if (run.decision === "blocked" || run.decision === "needs_review") {
    // A hard compliance outcome won't spontaneously clear on an unattended
    // retry — stop cleanly and say so, instead of silently skipping forever.
    row.status = "failed" as ScheduleStatus;
    row.lastError = run.detail ?? "Blocked by compliance.";
  } else {
    // Execution error — assume transient, retry the SAME occurrence after a
    // backoff rather than advancing past it or hammering immediately.
    row.failureCount += 1;
    row.lastError = run.detail ?? "Execution failed.";
    if (row.failureCount >= MAX_CONSECUTIVE_FAILURES) {
      row.status = "failed" as ScheduleStatus;
    } else {
      row.nextRun = Date.now() + RETRY_BACKOFF_MS;
    }
  }

  await persist(row);
  return row;
}
