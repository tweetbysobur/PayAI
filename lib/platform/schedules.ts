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
import type { AutomationIntervalUnit, ScheduleCadence, ScheduledPayment, ScheduleStatus, ScheduleEndCondition, RefundRecord } from "./types";

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
function label(row: Pick<ScheduledPayment, "amount" | "token" | "domain" | "recipient">): string {
  return `${row.amount} ${row.token} → ${row.domain ?? short(row.recipient)}`;
}

const mKey = (m: string) => `veripay:${m}:schedules`;
const GLOBAL_KEY = "veripay:schedules:all";
const DUE_INDEX_KEY = "veripay:schedules:due-index";
/** Sorted set of automation ids whose Reserved Funds refund is owed but
 *  hasn't landed yet (reserveRefundStatus === "pending") — lets the cron
 *  tick retry them without a full scan. Score is the time it entered
 *  "pending", purely so retryPendingRefunds can process oldest-first;
 *  membership, not score, is what matters. */
const PENDING_REFUND_INDEX_KEY = "veripay:schedules:pending-refunds";
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

/** Add `months` calendar months to `d`, clamping to the target month's last
 *  day instead of letting it overflow. `Date#setUTCMonth` alone rolls a day
 *  that doesn't exist in the target month into the following month (e.g. Jan
 *  31 + 1 month lands on Mar 3, not Feb 28) — which for a monthly automation
 *  due on the 29th/30th/31st would silently skip or shift months forever. */
function addUTCMonths(d: Date, months: number, anchorDay?: number | null): void {
  const day = anchorDay && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : d.getUTCDate();
  d.setUTCDate(1); // park on a day valid in every month while the month itself shifts
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
}

/** Hard iteration cap on the catch-up loop in advanceRunPast(). Purely an
 *  infinite-loop guard — 10k iterations covers ~27 years of a daily cadence,
 *  far beyond any real backlog, and advanceRun() always moves forward by at
 *  least a day so the loop terminates on its own well before this. */
const MAX_CATCHUP_ITERATIONS = 10_000;

/**
 * Advance to the first occurrence strictly AFTER `now`, reporting how many
 * missed occurrences were passed over on the way.
 *
 * advanceRun() alone moves exactly ONE period from the (possibly long-stale)
 * previous nextRun, which is correct only when the scheduler has been running
 * on time. If it hasn't — the cron endpoint's own doc notes the external
 * pinger has been paused before with nothing detecting the gap — then a single
 * advance lands on a time that is STILL in the past, the automation stays due,
 * and the very next tick executes it again. A daily automation missed for ten
 * days would fire eleven real payments a minute apart while it "caught up".
 *
 * Missed occurrences are deliberately SKIPPED rather than replayed. Draining a
 * user's wallet with a burst of back-dated payments because infrastructure was
 * down is strictly worse than missing them: the money moves at a price/time
 * the user never chose, and the on-chain daily cap would reject most of the
 * burst anyway, turning one outage into a wall of failures. A genuine catch-up
 * is still available deliberately, per occurrence, via "Execute Now".
 */
export function advanceRunPast(
  from: number,
  cadence: ScheduleCadence,
  interval: { count?: number; unit?: AutomationIntervalUnit } | undefined,
  now: number = Date.now(),
  timeZone?: string | null,
  anchorDay?: number | null,
): { next: number | null; skipped: number } {
  let next = advanceRun(from, cadence, interval, timeZone, anchorDay);
  if (next == null) return { next: null, skipped: 0 }; // one-off: completes, never repeats
  let skipped = 0;
  for (let i = 0; i < MAX_CATCHUP_ITERATIONS && next <= now; i++) {
    const following = advanceRun(next, cadence, interval, timeZone, anchorDay);
    // Defensive: advanceRun always moves forward for a recurring cadence, so
    // this can't normally fire — but never spin if that ever stops holding.
    if (following == null || following <= next) break;
    next = following;
    skipped += 1;
  }
  return { next, skipped };
}

/** The wall-clock parts of an instant in an IANA timezone, or null when the
 *  zone isn't one this runtime knows. */
function zonedParts(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const out = { y: n("year"), mo: n("month"), d: n("day"), h: n("hour") % 24, mi: n("minute"), s: n("second") };
  return Object.values(out).every(Number.isFinite) ? out : null;
}

/** The instant whose wall clock in `timeZone` reads y-mo-d h:mi:s. In a
 *  spring-forward gap (a time that doesn't exist that day) it lands just
 *  after the gap; in a fall-back overlap, on the first of the two. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (ms: number) => {
    const p = zonedParts(ms, timeZone)!;
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ms;
  };
  let guess = wall - offsetAt(wall);
  const second = wall - offsetAt(guess);
  if (second !== guess) guess = Math.min(guess, second);
  return guess;
}

/** The day of the month (1–31) a monthly automation is anchored to: its run
 *  date's day in its timezone (UTC when the zone is unknown). Undefined for
 *  cadences that don't step by months. Exported for tests. */
export function monthlyAnchorDay(nextRun: number, cadence: ScheduleCadence, unit: AutomationIntervalUnit | undefined, timeZone?: string | null): number | undefined {
  if (!(cadence === "monthly" || (cadence === "custom" && unit === "months"))) return undefined;
  const p = timeZone ? zonedParts(nextRun, timeZone) : null;
  return p ? p.d : new Date(nextRun).getUTCDate();
}

/**
 * The automation's next run, keeping its LOCAL time of day in `timeZone`
 * across daylight-saving changes: a weekly run at 9:00 in New York stays at
 * 9:00 New York time after the clocks change, rather than drifting to 8:00
 * or 10:00 as a fixed 7×24h step in UTC would. Without a usable timezone it
 * falls back to UTC arithmetic (the behaviour before timezones were stored).
 */
export function advanceRun(
  from: number, cadence: ScheduleCadence, interval?: { count?: number; unit?: AutomationIntervalUnit }, timeZone?: string | null,
  anchorDay?: number | null,
): number | null {
  const local = timeZone ? zonedParts(from, timeZone) : null;
  if (local && timeZone) {
    // Step the CALENDAR date (as if it were UTC — only the date matters here),
    // then put the original wall-clock time back on it in the zone.
    const cal = new Date(Date.UTC(local.y, local.mo - 1, local.d));
    const next = advanceRun(cal.getTime(), cadence, interval, null, anchorDay);
    if (next == null) return null;
    const c = new Date(next);
    return zonedToUtc(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), local.h, local.mi, local.s, timeZone);
  }
  const d = new Date(from);
  const count = Math.max(1, Math.floor(interval?.count ?? 1));
  switch (cadence) {
    case "daily": d.setUTCDate(d.getUTCDate() + 1); return d.getTime();
    case "weekly": d.setUTCDate(d.getUTCDate() + 7); return d.getTime();
    case "monthly": addUTCMonths(d, 1, anchorDay); return d.getTime();
    case "custom":
      if (interval?.unit === "weeks") d.setUTCDate(d.getUTCDate() + count * 7);
      else if (interval?.unit === "months") addUTCMonths(d, count, anchorDay);
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
    /** The PaymentExecutor/AutomationVault contract addresses currently live
     *  at creation time, stamped once so a later redeploy never affects this
     *  automation — see PaymentAutomation.executorAddress/vaultAddress. */
    executorAddress?: string | null;
    vaultAddress?: string | null;
    feeOnTop?: boolean;
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
    anchorDay: monthlyAnchorDay(input.nextRun, input.cadence, input.cadence === "custom" ? input.intervalUnit ?? "days" : undefined, input.timezone ?? "Africa/Lagos"),
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
    executorAddress: input.executorAddress ?? null,
    vaultAddress: input.vaultAddress ?? null,
    ...(input.feeOnTop ? { feeOnTop: true } : {}),
  };
  await persist(row);
  await recordAutomationEvent({
    merchantId, automationId: row.id, sender: row.sender, type: "created",
    title: "Automation created", detail: `${label(row)} — ${row.cadence}, next run ${new Date(row.nextRun).toLocaleString()}.`,
    amount: row.amount, token: row.token,
  });
  // A wallet-level notification (not automation-level) — the moment the
  // owner authorized this automation with a signature, distinct from the
  // "created" event above which is about the automation record itself.
  if (row.signature && row.sender) {
    const { recordWalletEvent } = await import("./walletEvents");
    await recordWalletEvent({
      merchantId, sender: row.sender, type: "automation_signed", providerId: "injected",
      title: "Automation signed", detail: `You authorized ${label(row)} — ${row.cadence}.`,
      amount: row.amount, token: row.token,
    }).catch(() => {});
  }
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
  // A new first run, cadence or timezone sets the monthly anchor afresh.
  if (patch.nextRun != null || patch.cadence != null || patch.intervalUnit != null || patch.timezone != null) {
    row.anchorDay = monthlyAnchorDay(row.nextRun, row.cadence, row.intervalUnit, row.timezone);
  }
  await persist(row);
  await recordAutomationEvent({
    merchantId, automationId: row.id, sender: row.sender, type: "updated",
    title: "Automation updated", detail: `${label(row)}'s terms were changed.`,
    amount: row.amount, token: row.token,
  });
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
  // A cancelled automation will never run again, so holding its deposit
  // serves no purpose — hand it straight back.
  await refundReservedIfAny(row, "the automation was cancelled");
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
  // "cancelled" is terminal, same as "completed": cancelling already handed
  // any Reserved Funds deposit back to the depositor (see below), so
  // resuming or pausing a cancelled row would re-arm a schedule with nothing
  // backing it -- for a wallet-funded automation that would let it actually
  // charge the user again after they'd cancelled it. Re-cancelling an
  // already-cancelled row stays allowed (idempotent, see refundReservedIfAny).
  if (row.status === "cancelled" && status !== "cancelled") return null;
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
    // A cancelled automation will never run again, so its Reserved Funds
    // deposit has nothing left to pay for — hand it straight back, exactly as
    // cancelSchedule() does.
    //
    // This was missing, and it was the path the dashboard's Cancel button
    // actually took. The money was not lost, but it was stranded with no way
    // out that a user could find: the retry sweeper only looks at rows marked
    // "pending", which this path never set, and the UI only offers refund
    // recovery on that same marker. So the deposit sat in the vault, no
    // automatic attempt was ever made, and nothing on screen said so.
    // Idempotent and lock-guarded (see refundReservedIfAny), so a row
    // cancelled twice, or cancelled through both routes, refunds once.
    await refundReservedIfAny(row, "the automation was cancelled");
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
  // Deleting removes the row entirely, so this is the LAST chance to refund a
  // Reserved Funds deposit through the normal automation record — after this,
  // recovering it requires the manual "paste a tx hash" tool. A user can
  // delete straight from active/paused without cancelling first, so this
  // can't assume cancelSchedule already ran. Best-effort and never blocks the
  // delete itself: refundReservedIfAny never throws.
  await refundReservedIfAny(row, "the automation was deleted");
  const r = await getRedis();
  if (r) {
    const client = r as unknown as { hdel?: (key: string, field: string) => Promise<unknown> };
    await client.hdel?.(mKey(row.merchantId), row.id);
    await client.hdel?.(GLOBAL_KEY, row.id);
    // Every other exit from "live" goes through persist(), which keeps this
    // index in sync — delete bypasses persist() entirely (it removes the row,
    // not updates it), so it's the one place that must clean the index itself.
    // Currently harmless (fetchByIds null-filters a hget miss), but the index
    // exists specifically so dueSchedules() scales with due count rather than
    // total-ever-created, and every uncleaned id erodes that.
    try {
      await r.zrem(DUE_INDEX_KEY, row.id);
    } catch {
      /* the full-scan fallback in dueSchedules/dueForReminder covers this */
    }
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
  /** Occurrences passed over because the scheduler had fallen behind — never
   *  silently swallowed; surfaced as its own event below so a user can see
   *  exactly which payments did NOT go out. */
  let skippedByBacklog = 0;
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
    // Past `now`, not just one period on — otherwise an automation that fell
    // behind during a scheduler outage stays due and re-fires on every tick
    // until it catches up. See advanceRunPast().
    const { next: nextByCadence, skipped: missedOccurrences } = advanceRunPast(
      row.nextRun, row.cadence, { count: row.intervalCount, unit: row.intervalUnit }, Date.now(), row.timezone, row.anchorDay,
    );
    const endedByCount = endCondition.type === "after_count" && row.runsCompleted >= endCondition.totalRuns;
    const endedByDate = endCondition.type === "until_date" && nextByCadence != null && nextByCadence > endCondition.untilMs;
    if (nextByCadence == null || endedByCount || endedByDate) {
      row.status = "completed" as ScheduleStatus;
    } else {
      row.nextRun = nextByCadence;
      skippedByBacklog = missedOccurrences;
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

  // Terminal states for a Reserved Funds automation: it has either stopped for
  // good ("failed" — a hard compliance block, or retries exhausted) or finished
  // its whole schedule ("completed"). Either way nothing further will draw on
  // the reservation, so any remaining balance goes back to the depositor
  // instead of sitting in the vault indefinitely.
  if (row.status === "failed" || row.status === "completed") {
    await refundReservedIfAny(
      row,
      row.status === "failed" ? "the automation stopped after a failed execution" : "the automation finished its schedule",
      row.status === "failed" ? run.at : null,
    );
  }

  // Say plainly that occurrences were missed. Skipping them is the right
  // call (see advanceRunPast), but a payment product must never let payments
  // quietly not happen — the user needs to know which ones to re-send by hand.
  if (skippedByBacklog > 0) {
    await recordAutomationEvent({
      merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "skipped",
      title: skippedByBacklog === 1 ? "1 occurrence was missed" : `${skippedByBacklog} occurrences were missed`,
      detail:
        `The scheduler was behind, so ${skippedByBacklog === 1 ? "1 scheduled payment was" : `${skippedByBacklog} scheduled payments were`} ` +
        `skipped rather than all sent at once. Nothing was paid for ${skippedByBacklog === 1 ? "it" : "them"}. ` +
        // Not "use Execute Now": that runs the NEXT payment early and moves
        // the schedule on, so it would skip that one instead of making up a
        // missed one.
        `The next run is ${new Date(row.nextRun).toLocaleString()}. To make up a missed payment, send it from Send in Payments & Automations.`,
      amount: row.amount, token: row.token,
    });
  }

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
  // Past `now` for the same reason recordRun() does it: landing on a still-due
  // time would have the cron execute the very occurrence the owner just
  // skipped, on its next tick.
  const { next: nextByCadence } = advanceRunPast(row.nextRun, row.cadence, { count: row.intervalCount, unit: row.intervalUnit }, Date.now(), row.timezone, row.anchorDay);
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
  // Skipping the LAST occurrence completes the automation, which makes this a
  // terminal state like any other — and terminal means the reservation has
  // nothing left to pay for. Missing here for the same reason it was missing
  // from the cancel path: the refund lived with the obvious exits and not with
  // every route that can reach one.
  if (row.status === "completed") {
    await refundReservedIfAny(row, "the automation finished its schedule");
  }
  await recordAutomationEvent({
    merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "skipped",
    title: "Execution skipped", detail: `${label(row)}'s next scheduled run was skipped — no payment was sent.`,
    amount: row.amount, token: row.token,
  });
  return row;
}

/**
 * Return a Reserved Funds automation's unspent reservation to the wallet that
 * deposited it, and tell the user it happened.
 *
 * Called whenever a reserved automation reaches a state where it will never
 * run again — cancelled, or terminally failed. Before this existed, cancelling
 * or exhausting a reserved automation left the deposit sitting in the vault
 * with no path back through the UI at all: the money was recoverable on-chain
 * but effectively invisible, which is how a real user ended up with 400 MON
 * stranded.
 *
 * Deliberately best-effort and never throws. The status change is the caller's
 * actual job; if the chain leg fails the reservation stays intact and is
 * refunded on the next attempt, so the worst case is a delay, never a loss.
 *
 * Guarded against duplicate refunds two ways:
 *   1. If this row is already marked "refunded", skip entirely — no reason
 *      to touch the chain again, and re-checking would be actively wrong:
 *      reservedBalance would read 0 (already paid out) and get
 *      misread as outcome "none" ("nothing was ever owed"), silently
 *      downgrading a correct "refunded" status back to "none".
 *   2. A short-lived mutex (the same claimRequest/releaseRequest primitive
 *      used for execution idempotency, borrowed here purely as a lock, not
 *      a long-term cache — always released when this call finishes,
 *      regardless of outcome) serializes concurrent callers. This function
 *      has three real call sites (cancel, delete, recordRun's terminal
 *      path) that could plausibly race on the same automation — e.g. a user
 *      clicking "delete" the instant a scheduled run independently pushes
 *      the same automation to "failed". Without this, both calls could read
 *      reservedBalance before either's refund tx lands, both attempt
 *      refund() on-chain, and whichever finishes SECOND (its tx reverts,
 *      since the first already zeroed the balance) would persist "pending"
 *      even though the money is already back — the same false-alarm bug
 *      as (1), just via a race instead of a sequential re-trigger.
 */
async function refundReservedIfAny(row: ScheduledPayment, reason: string, originalExecutionAt?: number | null): Promise<void> {
  if (row.fundingMode !== "reserved") return;
  if (row.reserveRefundStatus === "refunded") return;

  const { claimRequest, releaseRequest } = await import("./idempotency");
  const lockKey = `refund-lock:${row.id}`;
  const lock = await claimRequest(lockKey);
  if (!lock.claimed) return; // a concurrent attempt already owns this — let it finish and persist the truth
  try {
    // Honest wording matters here: at this point we know a deposit was made
    // at some point (reserveTxHash) and it hasn't been refunded yet, but NOT
    // whether anything is actually still there to return — that's only known
    // after the on-chain check below. "Checking" never overclaims a refund
    // is coming; "started"/"returned" wording is reserved for once it's real.
    if (row.reserveTxHash) {
      await recordAutomationEvent({
        merchantId: row.merchantId, automationId: row.id, sender: row.sender,
        type: "refund_started",
        title: "Checking reserved funds",
        detail: `PayAI is checking whether any reserved balance for ${label(row)} needs to be returned, because ${reason}.`,
        amount: row.amount, token: row.token,
      });
    }
    const { refundReservationViaAgent } = await import("@/lib/monad/contracts");
    // The vault THIS automation actually reserved into — never the current
    // global config, which may point at a newer AutomationVault deployment
    // by the time this automation is cancelled/completed.
    const result = await refundReservationViaAgent(row.id, row.vaultAddress);

    if (result.outcome === "none") {
      // Checked on-chain, genuinely nothing left (fully spent through prior
      // runs, or already refunded) — this is the ONLY case that means
      // nothing is owed, distinct from "failed" below.
      row.reserveRefundStatus = "none";
      await persist(row);
      await removeFromPendingRefundIndex(row.id);
      return;
    }
    if (result.outcome === "failed") {
      // Something may still be reserved; this attempt just didn't land
      // (RPC hiccup, signer unavailable, tx reverted). The reservation is
      // untouched and refundable again later, either by another automatic
      // attempt (see retryPendingRefunds, run each cron tick) or the
      // dashboard's self-service "Recover reserved funds".
      row.reserveRefundStatus = "pending";
      await persist(row);
      await addToPendingRefundIndex(row.id);
      return;
    }

    const decimals = row.tokenDecimals ?? (row.token === "MON" ? 18 : 6);
    const amount = Number(result.amountRaw) / 10 ** decimals;
    const record: RefundRecord = {
      reason, amount, txHash: result.txHash, explorerUrl: result.explorerUrl,
      at: Date.now(), automationId: row.id, originalExecutionAt: originalExecutionAt ?? null,
    };
    row.reserveRefundTxHash = result.txHash;
    row.reserveRefundStatus = "refunded";
    row.refundHistory = [...(row.refundHistory ?? []), record];
    await persist(row);
    await removeFromPendingRefundIndex(row.id);
    await recordAutomationEvent({
      merchantId: row.merchantId, automationId: row.id, sender: row.sender,
      type: "refunded",
      title: "Reserved funds returned",
      detail: `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${row.token} was refunded to your wallet because ${reason}.`,
      amount, token: row.token,
      txHash: result.txHash, explorerUrl: result.explorerUrl,
    });
  } catch {
    // Reaching here means refundReservationViaAgent itself threw, which it
    // shouldn't (it catches internally) — treat identically to "failed" so
    // the row never regresses to looking like nothing was ever owed.
    row.reserveRefundStatus = "pending";
    await persist(row).catch(() => {});
    await addToPendingRefundIndex(row.id).catch(() => {});
  } finally {
    // Always release, regardless of outcome — this is a short-lived mutex
    // for THIS call, not a long-term idempotency cache (reserveRefundStatus
    // already serves that role and is deliberately still retryable from
    // "pending"/"none"). Leaving it held would permanently block every
    // future legitimate attempt for this automation.
    await releaseRequest(lockKey).catch(() => {});
  }
}

async function addToPendingRefundIndex(id: string): Promise<void> {
  const r = await getRedis();
  if (r) await r.zadd(PENDING_REFUND_INDEX_KEY, { score: Date.now(), member: id });
  // No in-memory-mode index — retryPendingRefunds falls back to scanning
  // `mem` directly in that mode (dev-only; production always has Redis).
}

async function removeFromPendingRefundIndex(id: string): Promise<void> {
  const r = await getRedis();
  if (r) await r.zrem(PENDING_REFUND_INDEX_KEY, id);
}

/**
 * Retry every Reserved Funds automation whose last refund attempt failed
 * (reserveRefundStatus === "pending") — called once per cron tick, best-
 * effort. Without this, a "pending" refund that misses its one synchronous
 * attempt (an RPC hiccup at the exact moment the automation went terminal)
 * would sit stuck forever with no automatic path back, relying entirely on
 * the user finding and using the dashboard's manual "Recover reserved
 * funds" tool — which most users would never think to look for.
 *
 * Safe to call as often as this: refundReservedIfAny is itself idempotent
 * (skips outright if already "refunded", and mutex-guarded against
 * concurrent/overlapping calls for the same automation), so calling it
 * again for something that already resolved, or that's mid-retry from
 * another trigger, is always a correct no-op.
 */
export async function retryPendingRefunds(limit = 25): Promise<number> {
  const r = await getRedis();
  let candidates: ScheduledPayment[] = [];
  if (r) {
    // byScore, matching the DUE_INDEX_KEY pattern above — score is the time
    // each entry was added, so this naturally processes oldest-first.
    const allIds = (await r.zrange(PENDING_REFUND_INDEX_KEY, 0, Date.now(), { byScore: true })) as string[];
    const ids = allIds.slice(0, limit);
    candidates = (await Promise.all(ids.map((id) => getSchedule(id)))).filter((s): s is ScheduledPayment => !!s);
  } else {
    candidates = [...mem.values()].filter((s) => s.reserveRefundStatus === "pending").slice(0, limit);
  }

  let retried = 0;
  for (const row of candidates) {
    if (row.fundingMode !== "reserved" || row.reserveRefundStatus !== "pending") {
      // Stale index entry (resolved by another path since it was added) —
      // clean it up rather than leave it to be re-checked forever.
      await removeFromPendingRefundIndex(row.id);
      continue;
    }
    await refundReservedIfAny(row, "an automatic retry after a previous refund attempt didn't land");
    retried += 1;
  }
  return retried;
}

/**
 * Record a refund the WALLET OWNER triggered directly against the vault
 * contract, bypassing the agent entirely — the dashboard's "Recover reserved
 * funds" self-service tool exists specifically so a user can get their money
 * back even if PayAI's agent is down or unwilling, which is the whole point
 * of Reserved Funds being non-custodial. Without this, the server's own row
 * never hears about it: reserveRefundStatus would stay stuck on "pending"
 * (or undefined) forever even though the user already has their funds back,
 * which is a false alarm just as real as the stuck-funds problem this whole
 * refund-tracking system exists to prevent.
 *
 * The caller (app/api/automations/route.ts) is responsible for verifying the
 * refund actually happened on-chain (decoding the vault's Refunded event for
 * this exact automation id from the given tx's receipt) before calling this
 * — this function trusts its caller completely and does no on-chain
 * verification itself, so it must never be reachable from an unverified path.
 */
export async function recordSelfReportedRefund(
  id: string,
  input: { txHash: string; amount: number },
): Promise<ScheduledPayment | null> {
  const row = await getSchedule(id);
  if (!row) return null;
  const alreadyRecorded = (row.refundHistory ?? []).some((r) => r.txHash.toLowerCase() === input.txHash.toLowerCase());
  if (alreadyRecorded) return row;
  row.reserveRefundTxHash = input.txHash;
  row.reserveRefundStatus = "refunded";
  const record: RefundRecord = {
    reason: "the wallet owner recovered the reservation directly",
    amount: input.amount, txHash: input.txHash, at: Date.now(), automationId: row.id, originalExecutionAt: null,
  };
  row.refundHistory = [...(row.refundHistory ?? []), record];
  await persist(row);
  await removeFromPendingRefundIndex(row.id);
  await recordAutomationEvent({
    merchantId: row.merchantId, automationId: row.id, sender: row.sender, type: "refunded",
    title: "Reserved funds returned",
    detail: `${input.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${row.token} was refunded directly to your wallet.`,
    amount: input.amount, token: row.token, txHash: input.txHash,
  });
  return row;
}
