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

/**
 * How stale the heartbeat is allowed to be before we call the scheduler
 * "unhealthy". This must track the REAL invocation cadence, not vercel.json's
 * nominal once-daily cron entry (see app/api/cron/run-schedules/route.ts) —
 * production is actually driven by an external pinger hitting this endpoint
 * roughly every minute, which is what the app's own UI now promises users
 * ("PayAI checks for due automations roughly every minute"). A 24h+ threshold
 * here would make this check useless for its actual job: if that external
 * pinger died right now, nothing would call it "unhealthy" until a full day
 * later, silently breaking the exact promise just made to users. 5 minutes
 * gives room for ordinary serverless cold-start jitter without masking a
 * real outage for anywhere near that long.
 */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export function isHeartbeatStale(beat: CronHeartbeat | null, now: number = Date.now()): boolean {
  if (!beat) return true;
  return now - beat.finishedAt > HEARTBEAT_STALE_MS;
}
