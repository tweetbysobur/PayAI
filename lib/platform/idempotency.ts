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
/** The default record lifetime. A caller may ask for a different one per
 *  record (claimRequest / completeRequest `ttlSeconds`); nothing else does. */
export const IDEMPOTENCY_TTL_SECONDS = TTL_SECONDS;

export interface IdempotencyOptions {
  /** This record's lifetime in seconds (a positive integer). Defaults to IDEMPOTENCY_TTL_SECONDS. */
  ttlSeconds?: number;
}

function ttlOf(opts: IdempotencyOptions | undefined): number {
  if (opts?.ttlSeconds === undefined) return TTL_SECONDS;
  if (!Number.isSafeInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0) throw new Error("ttlSeconds must be a positive integer.");
  return opts.ttlSeconds;
}

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
/** In-memory records with a non-default lifetime: requestId → ttlSeconds. */
const gt = globalThis as unknown as { __veripayIdemTtl?: Map<string, number> };
const memTtl = (gt.__veripayIdemTtl ??= new Map());

function pruneMem() {
  const now = Date.now();
  for (const [k, v] of mem) {
    if (v.createdAt < now - (memTtl.get(k) ?? TTL_SECONDS) * 1000) {
      mem.delete(k);
      memTtl.delete(k);
    }
  }
}
function memSet(requestId: string, record: IdempotencyRecord<unknown>, ttl: number) {
  mem.set(requestId, record);
  if (ttl === TTL_SECONDS) memTtl.delete(requestId);
  else memTtl.set(requestId, ttl);
}

/**
 * Deterministic id from request content — the no-client-key fallback.
 *
 * Key order must not affect the hash (two callers building the same request
 * with differently-ordered object literals have to collide), so keys are
 * sorted before serializing. It does this by REBUILDING the object in sorted
 * order rather than passing the sorted keys as JSON.stringify's replacer
 * array: a replacer array filters keys at EVERY nesting level, so any nested
 * key whose name doesn't happen to also appear at the top level is silently
 * dropped from the hash. Two requests differing only inside a nested object
 * — say `{ action, meta: { amount: 5 } }` vs `{ action, meta: { amount: 999 } }`
 * — would then hash identically, and the second payment would be swallowed as
 * a "duplicate" of the first. Every current caller passes flat primitives, so
 * that was latent rather than live; rebuilding produces byte-identical JSON
 * for flat input (so existing ids are unchanged) while making the nested case
 * correct instead of dangerous.
 */
export function computeRequestId(parts: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.keys(parts).sort().map((k) => [k, parts[k]]));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Deterministic id from a wallet signature — for any mutation whose proof
 * of authorization is itself the thing worth deduping on. A wallet
 * signature is minted fresh per real user action (the message it signs
 * embeds a fresh timestamp — see app/dashboard/automations/page.tsx's
 * signMutation()), but stable across a retry of that exact same signed
 * request, so hashing it gives a key that collides on a duplicate delivery
 * of one signed proof without needing a client-supplied idempotency key or
 * a coarse time bucket that could also swallow two genuinely distinct
 * actions. Used by app/api/automations/route.ts for automation-create and
 * for the "Execute Now" manual trigger — Date.now() was used there before,
 * which is never deterministic and defeats claimRequest() entirely.
 */
export function hashSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("hex");
}

/**
 * Atomically claim a request id. Returns:
 *   - { claimed: true }                  → caller should execute now.
 *   - { claimed: false, status: "done" } → caller should return `result` as-is (replay).
 *   - { claimed: false, status: "in_progress" } → a concurrent attempt is mid-flight; caller should 409.
 */
export async function claimRequest<T>(
  requestId: string,
  opts?: IdempotencyOptions,
): Promise<{ claimed: true } | { claimed: false; status: IdempotencyStatus; result?: T }> {
  const ttl = ttlOf(opts);
  const r = await getRedis();
  if (r) {
    // SET NX, not GET-then-SET. A read followed by a write is two round trips
    // with a gap between them, and two requests that arrive in that gap both
    // see "no record" and both claim — which is precisely the collision this
    // module exists to prevent, and it happens most readily under the load
    // that makes double-submits likely in the first place. NX decides the
    // winner inside Redis, in one atomic step; the loser reads the record
    // afterwards to find out whether to replay a result or report a 409.
    const claimed = await r.set(
      key(requestId),
      { status: "in_progress", createdAt: Date.now() } as IdempotencyRecord<T>,
      { nx: true, ex: ttl },
    );
    if (claimed) return { claimed: true };
    const existing = (await r.get(key(requestId))) as IdempotencyRecord<T> | null;
    // Lost the race, but the record vanished between the two calls (TTL expiry
    // on a 24h-old key). Nothing is in flight and nothing was recorded, so
    // treat it as free rather than stalling a caller behind a ghost.
    if (!existing) return { claimed: true };
    return { claimed: false, status: existing.status, result: existing.result };
  }

  pruneMem();
  const existing = mem.get(requestId) as IdempotencyRecord<T> | undefined;
  if (existing) return { claimed: false, status: existing.status, result: existing.result };
  memSet(requestId, { status: "in_progress", createdAt: Date.now() }, ttl);
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
export async function completeRequest<T>(requestId: string, result: T, opts?: IdempotencyOptions): Promise<void> {
  const ttl = ttlOf(opts);
  const record: IdempotencyRecord<T> = { status: "done", result, createdAt: Date.now() };
  const r = await getRedis();
  if (r) {
    // TTL in the same command. Setting it separately leaves a window where a
    // failed EXPIRE strands the record forever, which would permanently block
    // that requestId from ever being usable again.
    await r.set(key(requestId), record, { ex: ttl });
    return;
  }
  memSet(requestId, record, ttl);
}

/** Release a claim without recording a result — used when execution fails before any chain action, so a genuine retry isn't permanently blocked. */
export async function releaseRequest(requestId: string): Promise<void> {
  const r = await getRedis();
  if (r) {
    // DEL, not SET null. Writing a null value leaves a key behind with no TTL
    // (SET clears the old expiry), so a released claim would sit in Redis
    // forever — invisible to `get`, but never reclaimed.
    await r.del(key(requestId));
    return;
  }
  mem.delete(requestId);
  memTtl.delete(requestId);
}
