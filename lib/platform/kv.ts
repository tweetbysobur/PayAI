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
   *  submitting the same handle at the same moment cannot both win — and what
   *  makes an idempotency claim safe, for the same reason.
   *  `opts.ex` sets the TTL in the same round trip, so a claim can never be
   *  written without its expiry (a separate EXPIRE can fail in between and
   *  leave the key immortal). */
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  // Sorted-set ops — used to index automations by nextRun so the cron's
  // due-check is a bounded range query instead of a full-table scan.
  zadd(key: string, entry: { score: number; member: string }): Promise<unknown>;
  zrange(key: string, min: number, max: number, opts: { byScore: true }): Promise<string[]>;
  zrem(key: string, member: string): Promise<unknown>;
}

let _redis: RedisLike | null | undefined;
/** Set when KV IS configured but its client could not be created. getRedis()
 *  still returns null then (callers that tolerate memory keep their old
 *  behaviour); getDurableRedis() refuses instead. */
let _redisInitFailed = false;

export async function getRedis(): Promise<RedisLike | null> {
  if (_redis !== undefined) return _redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return (_redis = null);
  try {
    const { Redis } = await import("@upstash/redis");
    _redis = new Redis({ url, token }) as unknown as RedisLike;
  } catch {
    _redisInitFailed = true;
    _redis = null;
  }
  return _redis;
}

/* ── Durable storage for money-path records ────────────────────────────── */

/**
 * Why shared storage was unavailable — never confused with "the record
 * doesn't exist", which is an ordinary null/absent result:
 *   not_configured      production, and KV_REST_API_URL/TOKEN are not set
 *   client_unavailable  KV is configured but its client could not be created
 *   operation_failed    a KV call itself failed (network, auth, Upstash error)
 */
export type StorageFailure = "not_configured" | "client_unavailable" | "operation_failed";

export class StorageUnavailableError extends Error {
  readonly failure: StorageFailure;
  constructor(failure: StorageFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageUnavailableError";
    this.failure = failure;
  }
}

/** A KV call that threw, as a StorageUnavailableError (already-typed errors pass through). */
export function asStorageError(e: unknown): StorageUnavailableError {
  if (e instanceof StorageUnavailableError) return e;
  return new StorageUnavailableError("operation_failed", "Shared storage operation failed.", { cause: e });
}

/**
 * The shared KV client for records that must be visible to every server
 * instance and survive restarts: payment approvals, confirmation claims and
 * results, and the transaction log written on the payment path.
 *
 * Fails closed, the way lib/plan/store.ts and lib/rooms/store.ts already do
 * for their data:
 *   - KV configured and its client created → the client.
 *   - KV configured but the client could not be created → throws
 *     client_unavailable, in EVERY environment: configured shared storage
 *     never silently degrades to per-instance memory.
 *   - KV not configured, in production (NODE_ENV=production — every Vercel
 *     deployment, and `next start`) → throws not_configured.
 *   - KV not configured, outside production (local `next dev`, vitest) →
 *     null: the caller uses its documented in-memory fallback. That mode is
 *     only reachable where NODE_ENV is not "production".
 */
export async function getDurableRedis(): Promise<RedisLike | null> {
  const r = await getRedis();
  if (r) return r;
  if (_redisInitFailed) {
    throw new StorageUnavailableError("client_unavailable", "Shared storage is configured but its client could not be created.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new StorageUnavailableError("not_configured", "Shared storage (KV_REST_API_URL/TOKEN) is not configured.");
  }
  return null;
}

export function kvEnabled(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}
