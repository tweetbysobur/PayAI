import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

/**
 * GET /api/health/kv — TEMPORARY production diagnostic.
 *
 * Proves the runtime can reach the shared KV (Upstash) with one disposable
 * SET NX EX / GET / DEL / GET cycle on a server-generated key. It touches no
 * plan, wallet, idempotency or transaction data, accepts no input, and returns
 * only a fixed status body: never a key, value, URL, credential or error.
 *
 * Uses the platform's own getRedis(); no separate client or env handling.
 * Not imported by any client or plan code. Remove once KV is verified.
 */
export const dynamic = "force-dynamic";

const PROBE_TTL_SECONDS = 30;
const NO_STORE = { "Cache-Control": "no-store" } as const;

function respond(ok: boolean): NextResponse {
  return NextResponse.json(
    ok ? { ok: true, storage: "shared_kv" } : { ok: false, storage: "unavailable" },
    { status: ok ? 200 : 503, headers: NO_STORE },
  );
}

export async function GET(): Promise<NextResponse> {
  let redis: Awaited<ReturnType<typeof import("@/lib/platform/kv").getRedis>> = null;
  try {
    const { getRedis } = await import("@/lib/platform/kv");
    redis = await getRedis();
  } catch {
    return respond(false);
  }
  if (!redis) return respond(false);

  const key = `payai_kv_probe:${randomBytes(16).toString("hex")}`;
  // The prefix keeps the stored value a non-numeric string, so the client's
  // JSON auto-decoding cannot turn it into another type on the way back.
  const value = `probe-${randomBytes(16).toString("hex")}`;
  let deleted = false;
  try {
    const written = await redis.set(key, value, { nx: true, ex: PROBE_TTL_SECONDS });
    if (written !== "OK") return respond(false);
    if ((await redis.get(key)) !== value) return respond(false);
    await redis.del(key);
    deleted = true;
    if ((await redis.get(key)) !== null) {
      deleted = false;
      return respond(false);
    }
    return respond(true);
  } catch {
    return respond(false);
  } finally {
    if (!deleted) await redis.del(key).catch(() => {});
  }
}
