/**
 * Shared KV (Upstash Redis) client for the platform layer.
 *
 * Returns a typed Redis handle when KV_REST_API_URL/TOKEN are present, else null
 * (callers fall back to in-memory). Centralizes the lazy import so store,
 * ratelimit, and merchants share one client and one detection path.
 *
 * Server-only.
 */
import "server-only";

export interface RedisLike {
  lpush(key: string, value: unknown): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  hset(key: string, kv: Record<string, unknown>): Promise<number>;
  hget(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<unknown>;
  /** `opts.nx` sets only if the key is absent, returning null when it already
   *  exists. That atomicity is what makes a username claim safe: two people
   *  submitting the same handle at the same moment cannot both win. */
  set(key: string, value: unknown, opts?: { nx?: boolean }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  // Sorted-set ops — used to index automations by nextRun so the cron's
  // due-check is a bounded range query instead of a full-table scan.
  zadd(key: string, entry: { score: number; member: string }): Promise<unknown>;
  zrange(key: string, min: number, max: number, opts: { byScore: true }): Promise<string[]>;
  zrem(key: string, member: string): Promise<unknown>;
}

let _redis: RedisLike | null | undefined;

export async function getRedis(): Promise<RedisLike | null> {
  if (_redis !== undefined) return _redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return (_redis = null);
  try {
    const { Redis } = await import("@upstash/redis");
    _redis = new Redis({ url, token }) as unknown as RedisLike;
  } catch {
    _redis = null;
  }
  return _redis;
}

export function kvEnabled(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}
