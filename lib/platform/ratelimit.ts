/**
 * Rate limiting for write endpoints — fixed-window counter.
 *
 * Backend: Upstash Redis (INCR + EXPIRE) when KV is configured, so limits hold
 * across serverless instances; in-memory fallback for local dev. Closes the DoS
 * / cost-abuse finding from the audit.
 *
 * Server-only.
 */
import "server-only";
import { NextRequest, NextResponse } from "next/server";

const WINDOW_SEC = Number(process.env.VERIPAYAI_RATE_WINDOW || "60");
const MAX_REQ = Number(process.env.VERIPAYAI_RATE_MAX || "30");

const g = globalThis as unknown as { __veripayRL?: Map<string, { count: number; resetAt: number }> };
const mem = (g.__veripayRL ??= new Map());

interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}
let _redis: RedisLike | null | undefined;
async function redis(): Promise<RedisLike | null> {
  if (_redis !== undefined) return _redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return (_redis = null);
  try {
    const { Redis } = await import("@upstash/redis");
    const { kvSignal } = await import("@/lib/platform/kv");
    _redis = new Redis({ url, token, signal: kvSignal }) as unknown as RedisLike;
  } catch {
    _redis = null;
  }
  return _redis;
}

function clientIp(req: NextRequest): string {
  // Prefer x-real-ip: on Vercel it's set by the platform to the true client IP
  // and is NOT settable by the caller. x-forwarded-for's leftmost entry is
  // attacker-controlled (a client can inject the header; the platform only
  // appends the real IP), so keying the limiter on it would let an attacker
  // rotate a fake IP every request and bypass rate limiting entirely.
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || "unknown";
}

/**
 * Returns a 429 response when the caller exceeds the window, else null.
 *
 * `opts` tightens the limit for buckets where the global default (built for
 * ordinary write traffic) is far too generous — sending sign-in emails, for
 * instance, costs real money per request and gates account access, so it
 * gets single-digit limits rather than 30/minute. `subject` keys the counter
 * on something other than the IP (e.g. the target email address), so an
 * attacker rotating IPs still can't flood one inbox.
 */
export async function rateLimited(
  req: NextRequest,
  bucket = "write",
  opts?: { max?: number; windowSec?: number; subject?: string },
): Promise<NextResponse | null> {
  const max = opts?.max ?? MAX_REQ;
  const windowSec = opts?.windowSec ?? WINDOW_SEC;
  const subject = opts?.subject?.trim().toLowerCase() || clientIp(req);
  const key = `veripay:rl:${bucket}:${subject}`;
  let count: number;

  const r = await redis();
  if (r) {
    count = await r.incr(key);
    if (count === 1) await r.expire(key, windowSec);
  } else {
    const now = Date.now();
    const e = mem.get(key);
    if (!e || e.resetAt < now) {
      mem.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      count = 1;
    } else {
      e.count += 1;
      count = e.count;
    }
  }

  if (count > max) {
    return NextResponse.json(
      { error: `Rate limit exceeded — max ${max} requests per ${windowSec}s.` },
      { status: 429, headers: { "Retry-After": String(windowSec) } },
    );
  }
  return null;
}
