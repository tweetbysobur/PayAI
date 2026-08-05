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
