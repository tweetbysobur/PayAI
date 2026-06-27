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
    _redis = new Redis({ url, token }) as unknown as RedisLike;
  } catch {
    _redis = null;
  }
  return _redis;
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : req.headers.get("x-real-ip"))?.trim() || "unknown";
}

/** Returns a 429 response when the caller exceeds the window, else null. */
export async function rateLimited(req: NextRequest, bucket = "write"): Promise<NextResponse | null> {
  const ip = clientIp(req);
  const key = `veripay:rl:${bucket}:${ip}`;
  let count: number;

  const r = await redis();
  if (r) {
    count = await r.incr(key);
    if (count === 1) await r.expire(key, WINDOW_SEC);
  } else {
    const now = Date.now();
    const e = mem.get(key);
    if (!e || e.resetAt < now) {
      mem.set(key, { count: 1, resetAt: now + WINDOW_SEC * 1000 });
      count = 1;
    } else {
      e.count += 1;
      count = e.count;
    }
  }

  if (count > MAX_REQ) {
    return NextResponse.json(
      { error: `Rate limit exceeded — max ${MAX_REQ} requests per ${WINDOW_SEC}s.` },
      { status: 429, headers: { "Retry-After": String(WINDOW_SEC) } },
    );
  }
  return null;
}
