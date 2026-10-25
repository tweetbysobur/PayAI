import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The idempotency claim has to be atomic, not merely careful.
 *
 * Every duplicate-payment guard in the app rests on `claimRequest` returning
 * `claimed: true` to exactly one caller. Implemented as a read followed by a
 * write, that promise is false: the two round trips leave a gap, and two
 * requests arriving inside it both see "no record" and both claim. That is
 * precisely the collision the module exists to prevent, and it is likeliest
 * under exactly the conditions that produce double-submits — a double-tapped
 * button, a retried serverless invocation, two cron ticks overlapping.
 *
 * These tests run against a fake Redis whose `set` implements real NX
 * semantics and whose operations yield to the event loop, the way a network
 * round trip does. That yielding is what lets a non-atomic implementation
 * interleave and fail here.
 */

const store = new Map<string, unknown>();

const fakeRedis = {
  async get(key: string) {
    await Promise.resolve(); // a round trip is not instantaneous
    return store.get(key) ?? null;
  },
  async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
    await Promise.resolve();
    if (opts?.nx && store.has(key)) return null; // NX: the key already exists
    store.set(key, value);
    return "OK";
  },
  async del(key: string) {
    await Promise.resolve();
    return store.delete(key) ? 1 : 0;
  },
  async expire() {
    await Promise.resolve();
    return 1;
  },
};

vi.mock("@/lib/platform/kv", () => ({
  getRedis: async () => fakeRedis,
  kvEnabled: () => true,
}));

describe("claimRequest — atomicity across instances", () => {
  beforeEach(() => {
    store.clear();
  });

  it("gives exactly one winner when two claims race", async () => {
    const { claimRequest } = await import("@/lib/platform/idempotency");
    const id = "race-1";

    const [a, b] = await Promise.all([claimRequest(id), claimRequest(id)]);

    const winners = [a, b].filter((r) => r.claimed);
    expect(winners, "two callers must not both be told to execute").toHaveLength(1);
  });

  it("gives exactly one winner across a burst of simultaneous claims", async () => {
    const { claimRequest } = await import("@/lib/platform/idempotency");
    const id = "race-many";

    const results = await Promise.all(Array.from({ length: 12 }, () => claimRequest(id)));

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it("tells the loser a claim is in flight, so it can 409 rather than execute", async () => {
    const { claimRequest } = await import("@/lib/platform/idempotency");
    const id = "race-status";

    const results = await Promise.all([claimRequest(id), claimRequest(id)]);
    const loser = results.find((r) => !r.claimed);

    expect(loser).toBeDefined();
    if (loser && !loser.claimed) expect(loser.status).toBe("in_progress");
  });

  it("replays a completed result to a later caller instead of re-running", async () => {
    const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
    const id = "replay-1";

    await claimRequest(id);
    await completeRequest(id, { outcome: "executed", txHash: "0xabc" });

    const again = await claimRequest<{ outcome: string }>(id);
    expect(again.claimed).toBe(false);
    if (!again.claimed) {
      expect(again.status).toBe("done");
      expect(again.result).toEqual({ outcome: "executed", txHash: "0xabc" });
    }
  });

  it("stores the claim with its expiry in one command", async () => {
    // A separate EXPIRE can fail after the SET lands, stranding a claim that
    // then blocks its requestId forever. The TTL has to ride along.
    const spy = vi.spyOn(fakeRedis, "set");
    const { claimRequest } = await import("@/lib/platform/idempotency");
    await claimRequest("ttl-1");

    expect(spy).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ nx: true, ex: expect.any(Number) }));
    spy.mockRestore();
  });

  it("frees the id on release, rather than leaving a key behind", async () => {
    // Releasing by writing null leaves a TTL-less key in Redis: invisible to
    // `get`, never reclaimed, one per abandoned request forever.
    const { claimRequest, releaseRequest } = await import("@/lib/platform/idempotency");
    const id = "release-1";

    await claimRequest(id);
    await releaseRequest(id);

    expect(store.size, "the released key must be gone, not merely emptied").toBe(0);
    expect((await claimRequest(id)).claimed, "a released id must be claimable again").toBe(true);
  });
});

/* ══ Stage 5C-2e — record lifetime ═════════════════════════════════════════ */

describe("record lifetime (5C-2e): 24h by default; an explicit ttlSeconds only where asked", () => {
  beforeEach(() => {
    store.clear();
  });
  const setOpts = () => {
    const spy = vi.spyOn(fakeRedis, "set");
    return { spy, opts: () => spy.mock.calls.map((c) => c[2]) };
  };

  it("claimRequest and completeRequest default to exactly 24h (86,400 s)", async () => {
    const { claimRequest, completeRequest, IDEMPOTENCY_TTL_SECONDS } = await import("@/lib/platform/idempotency");
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    const { spy, opts } = setOpts();
    await claimRequest("ttl-default");
    await completeRequest("ttl-default", { ok: 1 });
    expect(opts()).toEqual([{ nx: true, ex: 86_400 }, { ex: 86_400 }]);
    spy.mockRestore();
  });
  it("an explicit ttlSeconds is used for that record's claim and completion only", async () => {
    const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
    const { spy, opts } = setOpts();
    await claimRequest("ttl-long", { ttlSeconds: 691_200 });
    await completeRequest("ttl-long", { ok: 1 }, { ttlSeconds: 691_200 });
    await claimRequest("ttl-other");
    expect(opts()).toEqual([{ nx: true, ex: 691_200 }, { ex: 691_200 }, { nx: true, ex: 86_400 }]);
    spy.mockRestore();
  });
  it("an invalid ttlSeconds is refused, never silently replaced", async () => {
    const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(claimRequest("ttl-bad", { ttlSeconds })).rejects.toThrow(/ttlSeconds/);
      await expect(completeRequest("ttl-bad", 1, { ttlSeconds })).rejects.toThrow(/ttlSeconds/);
    }
    expect(store.has("veripay:idem:ttl-bad")).toBe(false);
  });
  it("source guard: only the SDK build route and the payment-confirm lease ask for a non-default lifetime", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(join(root, "app"));
    walk(join(root, "lib"));
    // Callers of the idempotency module that pass a lifetime (lib/plan/store.ts's own
    // backend also has a ttlSeconds parameter, unrelated to this module).
    const users = files
      .filter((f) => { const src = readFileSync(f, "utf8"); return /ttlSeconds/.test(src) && (/@\/lib\/platform\/idempotency/.test(src) || f.endsWith("idempotency.ts")); })
      .map((f) => f.slice(root.length + 1)).sort();
    expect(users).toEqual(["app/api/agent/confirm/route.ts", "app/api/ask/action/build/route.ts", "lib/platform/idempotency.ts"]);
    // /api/agent/confirm: only its in-progress CLAIM is a short lease; the
    // finished confirmation keeps the default 24h.
    const confirm = readFileSync(join(root, "app/api/agent/confirm/route.ts"), "utf8");
    expect(confirm).toMatch(/const CONFIRM_LEASE_SECONDS = 150;/);
    const confirmCalls = [...confirm.matchAll(/(claimRequest|completeRequest)(<[^>]*>)?\(([^;]*?)\);/g)].map((m) => [m[1], m[3]]);
    expect(confirmCalls).toEqual([
      // ...DURABLE: shared storage only, fail-closed in production (R4).
      ["claimRequest", "confirmKey, { ttlSeconds: CONFIRM_LEASE_SECONDS, ...DURABLE }"],
      ["completeRequest", "confirmKey, stored, DURABLE"],
    ]);
    const build = readFileSync(join(root, "app/api/ask/action/build/route.ts"), "utf8");
    expect(build).toMatch(/BUILD_RECORD_TTL = \{ ttlSeconds: PLAN_TTL_SECONDS \+ PLAN_RETENTION_GRACE_SECONDS \}/);
    const calls = [...build.matchAll(/(claimRequest|completeRequest)(<[^>]*>)?\(([^;]*?)\)/g)].map((m) => m[3]);
    expect(calls.length).toBe(4);
    for (const args of calls) expect(args).toMatch(/BUILD_RECORD_TTL$/);
  });
});
