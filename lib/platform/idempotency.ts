/**
 * Idempotency protection for payment execution.
 *
 * Two layers, both required:
 *   1. This module — a fast, server-side claim/replay cache keyed by request
 *      id. Works perfectly on a single warm instance; on Vercel's serverless
 *      runtime (no shared memory across instances) it's best-effort unless
 *      KV_REST_API_URL/TOKEN (Upstash Redis) is configured, in which case it's
 *      authoritative across all instances too.
 *   2. The on-chain guard in PaymentExecutor.sol (`usedRequestId`) — the real
 *      backstop. Even if this cache is unavailable (cold start, no KV), a
 *      duplicate execution attempt still gets rejected by the contract before
 *      a second transfer can happen. See lib/monad/contracts.ts.
 *
 * A request id is either supplied by the client (`idempotencyKey` in the
 * request body — the UI should generate one per submit and reuse it on retry)
 * or derived deterministically from the request's own content, so an
 * accidental double-click with no client-side key still collides.
 *
 * Server-only.
 */
import "server-only";
import { createHash } from "node:crypto";
import { getRedis } from "./kv";

const TTL_SECONDS = 24 * 60 * 60; // 24h — long enough to outlive any realistic retry window

export type IdempotencyStatus = "new" | "in_progress" | "done";

export interface IdempotencyRecord<T> {
  status: IdempotencyStatus;
  result?: T;
  createdAt: number;
}

const key = (id: string) => `veripay:idem:${id}`;

// In-memory fallback — correct within one warm instance, best-effort across
// Vercel's distributed serverless instances when KV isn't configured.
const g = globalThis as unknown as { __veripayIdem?: Map<string, IdempotencyRecord<unknown>> };
const mem = (g.__veripayIdem ??= new Map());

function pruneMem() {
  const cutoff = Date.now() - TTL_SECONDS * 1000;
  for (const [k, v] of mem) if (v.createdAt < cutoff) mem.delete(k);
}

/** Deterministic id from request content — the no-client-key fallback. */
export function computeRequestId(parts: Record<string, unknown>): string {
  const normalized = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Atomically claim a request id. Returns:
 *   - { claimed: true }                  → caller should execute now.
 *   - { claimed: false, status: "done" } → caller should return `result` as-is (replay).
 *   - { claimed: false, status: "in_progress" } → a concurrent attempt is mid-flight; caller should 409.
 */
export async function claimRequest<T>(
  requestId: string,
): Promise<{ claimed: true } | { claimed: false; status: IdempotencyStatus; result?: T }> {
  const r = await getRedis();
  if (r) {
    const existing = (await r.get(key(requestId))) as IdempotencyRecord<T> | null;
    if (existing) return { claimed: false, status: existing.status, result: existing.result };
    await r.set(key(requestId), { status: "in_progress", createdAt: Date.now() } as IdempotencyRecord<T>);
    await r.expire(key(requestId), TTL_SECONDS);
    return { claimed: true };
  }

  pruneMem();
  const existing = mem.get(requestId) as IdempotencyRecord<T> | undefined;
  if (existing) return { claimed: false, status: existing.status, result: existing.result };
  mem.set(requestId, { status: "in_progress", createdAt: Date.now() });
  return { claimed: true };
}

/**
 * Read a completed record's stored result without claiming or mutating it.
 * Returns the result only when the request finished (`status === "done"`),
 * else null. Used by the confirm path to replay the exact approved intent
 * instead of re-deriving it from raw text (which could drift).
 */
export async function peekRequest<T>(requestId: string): Promise<T | null> {
  const r = await getRedis();
  if (r) {
    const existing = (await r.get(key(requestId))) as IdempotencyRecord<T> | null;
    return existing?.status === "done" ? (existing.result ?? null) : null;
  }
  pruneMem();
  const existing = mem.get(requestId) as IdempotencyRecord<T> | undefined;
  return existing?.status === "done" ? ((existing.result as T) ?? null) : null;
}

/** Store the final outcome under a claimed request id so retries replay it. */
export async function completeRequest<T>(requestId: string, result: T): Promise<void> {
  const record: IdempotencyRecord<T> = { status: "done", result, createdAt: Date.now() };
  const r = await getRedis();
  if (r) {
    await r.set(key(requestId), record);
    await r.expire(key(requestId), TTL_SECONDS);
    return;
  }
  mem.set(requestId, record);
}

/** Release a claim without recording a result — used when execution fails before any chain action, so a genuine retry isn't permanently blocked. */
export async function releaseRequest(requestId: string): Promise<void> {
  const r = await getRedis();
  if (r) {
    await r.set(key(requestId), null);
    return;
  }
  mem.delete(requestId);
}
