/**
 * Client-side cadence math — shared by every wizard that needs to know how
 * many times a schedule will run and what to authorize/reserve up front
 * (the single-recipient AutomationCreator and BulkPaymentCreator).
 *
 * This is the client's own copy of the server's advanceRun
 * (lib/platform/schedules.ts, server-only — the client can't import it), but
 * the two MUST compute identical dates: what gets approved/reserved here is
 * sized against what the server will actually try to spend over the
 * schedule's real life. A single shared client-side copy means only two
 * implementations to ever keep in sync (this one + the server's), not one
 * per wizard.
 */

export type Cadence = "once" | "daily" | "weekly" | "monthly" | "custom";
export type IntervalUnit = "days" | "weeks" | "months";
export type EndMode = "never" | "after_count" | "until_date";

/** Add `months` calendar months to `d`, clamping to the target month's last
 *  day instead of letting it overflow (e.g. Jan 31 + 1 month -> Feb 28, not
 *  Mar 3) — mirrors addUTCMonths in lib/platform/schedules.ts. */
export function addUTCMonths(d: Date, months: number): void {
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
}

/** Advance a timestamp by one cadence step — mirrors the server's advanceRun. */
export function stepOnce(from: number, cadence: Cadence, intervalCount: number, intervalUnit: IntervalUnit): number {
  const d = new Date(from);
  const n = Math.max(1, intervalCount);
  if (cadence === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "monthly") addUTCMonths(d, 1);
  else if (cadence === "custom") {
    if (intervalUnit === "weeks") d.setUTCDate(d.getUTCDate() + n * 7);
    else if (intervalUnit === "months") addUTCMonths(d, n);
    else d.setUTCDate(d.getUTCDate() + n);
  }
  return d.getTime();
}

/** How many payments a schedule will make. Returns null for open-ended
 *  ("no end date") schedules, where the total is genuinely unbounded. */
export function countOccurrences(opts: {
  startAt: number; cadence: Cadence; intervalCount: number; intervalUnit: IntervalUnit;
  endMode: EndMode; endCount: number; endUntilMs: number;
}): number | null {
  if (opts.cadence === "once") return 1;
  if (opts.endMode === "after_count") return Math.max(1, Math.floor(opts.endCount) || 1);
  if (opts.endMode === "until_date") {
    if (!Number.isFinite(opts.endUntilMs) || opts.endUntilMs < opts.startAt) return 0;
    let n = 0; let t = opts.startAt; const CAP = 1000;
    while (t <= opts.endUntilMs && n < CAP) { n++; t = stepOnce(t, opts.cadence, opts.intervalCount, opts.intervalUnit); }
    return n;
  }
  return null; // never — open-ended
}

/** Roughly how much a per-run amount adds up to over a year — used to size
 *  an open-ended (no end date) Wallet Automation's approval, since an
 *  unbounded schedule has no "exact total" to approve. */
export function annualVolume(amount: number, cadence: Cadence, intervalCount: number, intervalUnit: IntervalUnit): number {
  if (cadence === "once") return amount;
  if (cadence === "daily") return amount * 365;
  if (cadence === "weekly") return amount * 52;
  if (cadence === "monthly") return amount * 12;
  const count = Math.max(1, intervalCount);
  if (intervalUnit === "weeks") return amount * (52 / count);
  if (intervalUnit === "months") return amount * (12 / count);
  return amount * (365 / count);
}
