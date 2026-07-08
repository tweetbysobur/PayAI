/**
 * Cron liveness heartbeat — the only way to notice "the daily automation
 * run silently didn't fire" before a user reports a missed payment. Vercel
 * registers the schedule correctly but gives no alert if a tick is skipped
 * (platform throttling, billing limits, a bad deploy at the scheduled
 * minute); this record is what turns that into something observable.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";

const HEARTBEAT_KEY = "veripay:cron:last-run";

export interface CronHeartbeat {
  startedAt: number;
  finishedAt: number;
  dueCount: number;
  processed: number;
}

let mem: CronHeartbeat | null = null;

export async function recordHeartbeat(beat: CronHeartbeat): Promise<void> {
  const r = await getRedis();
  if (r) {
    await r.set(HEARTBEAT_KEY, beat);
  } else {
    mem = beat;
  }
}

export async function getHeartbeat(): Promise<CronHeartbeat | null> {
  const r = await getRedis();
  if (r) {
    const v = await r.get(HEARTBEAT_KEY);
    return (v as CronHeartbeat | null) ?? null;
  }
  return mem;
}

/** How stale the heartbeat is allowed to be before we call the scheduler
 *  "unhealthy" — a bit over 24h to tolerate a normal daily cadence plus jitter. */
export const HEARTBEAT_STALE_MS = 26 * 60 * 60 * 1000;

export function isHeartbeatStale(beat: CronHeartbeat | null, now: number = Date.now()): boolean {
  if (!beat) return true;
  return now - beat.finishedAt > HEARTBEAT_STALE_MS;
}
