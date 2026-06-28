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
import type { ScheduleCadence, ScheduledPayment, ScheduleStatus } from "./types";

const mKey = (m: string) => `veripay:${m}:schedules`;
const GLOBAL_KEY = "veripay:schedules:all";

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
  input: { amount: number; token: string; recipient: string; domain?: string | null; cadence: ScheduleCadence; nextRun: number; memo?: string },
): Promise<ScheduledPayment> {
  const row: ScheduledPayment = {
    id: `sch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    merchantId,
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
  };
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

export async function listSchedules(merchantId: string): Promise<ScheduledPayment[]> {
  const r = await getRedis();
  let rows: ScheduledPayment[];
  if (r) {
    const h = (await r.hgetall(mKey(merchantId))) ?? {};
    rows = Object.values(h) as ScheduledPayment[];
  } else {
    rows = [...mem.values()].filter((s) => s.merchantId === merchantId);
  }
  // Upcoming first (soonest next-run), then completed/cancelled by recency.
  return rows.sort((a, b) => {
    if (a.status === "upcoming" && b.status === "upcoming") return a.nextRun - b.nextRun;
    if (a.status === "upcoming") return -1;
    if (b.status === "upcoming") return 1;
    return b.createdAt - a.createdAt;
  });
}

export async function cancelSchedule(merchantId: string, id: string): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row || row.merchantId !== merchantId) return null;
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

/** Record a fired run and either advance (recurring) or complete (one-off). */
export async function recordRun(
  id: string,
  run: { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string },
): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row) return null;
  row.runs = [run, ...row.runs].slice(0, 50);
  const next = advanceRun(row.nextRun, row.cadence);
  if (next == null) {
    row.status = "completed" as ScheduleStatus;
  } else {
    row.nextRun = next;
  }
  await persist(row);
  return row;
}
