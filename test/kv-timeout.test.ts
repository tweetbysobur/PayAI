import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every Upstash client gets a per-command deadline. Without one, a stalled KV
 * connection held API requests (rate limiting runs first on most routes) until
 * the platform killed them at 300s. The deadline must be a FUNCTION: given a
 * plain AbortSignal the client returns the string "Aborted" as if it were the
 * stored value; given a function it throws.
 */
const configs: Array<Record<string, unknown>> = [];
vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor(cfg: Record<string, unknown>) { configs.push(cfg); }
    async incr() { return 1; }
    async expire() { return 1; }
  },
}));

const saved = { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
beforeEach(() => {
  vi.resetModules();
  configs.length = 0;
  process.env.KV_REST_API_URL = "https://kv.example";
  process.env.KV_REST_API_TOKEN = "t";
});
afterEach(() => {
  if (saved.url === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = saved.url;
  if (saved.token === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = saved.token;
});

function expectDeadline(cfg: Record<string, unknown> | undefined) {
  expect(typeof cfg?.signal).toBe("function");
  const a = (cfg!.signal as () => AbortSignal)();
  const b = (cfg!.signal as () => AbortSignal)();
  expect(a).toBeInstanceOf(AbortSignal);
  expect(a.aborted).toBe(false);
  expect(a).not.toBe(b); // a fresh deadline per command, not one shared timer
}

describe("KV clients have a per-command deadline", () => {
  it("the shared KV store client", async () => {
    const { getRedis, KV_TIMEOUT_MS } = await import("@/lib/platform/kv");
    await getRedis();
    expect(KV_TIMEOUT_MS).toBeGreaterThan(0);
    expect(KV_TIMEOUT_MS).toBeLessThan(60_000);
    expectDeadline(configs[0]);
  });

  it("the rate limiter's client", async () => {
    const { rateLimited } = await import("@/lib/platform/ratelimit");
    const { NextRequest } = await import("next/server");
    await rateLimited(new NextRequest("https://app.example/api/x", { headers: { "x-real-ip": "1.2.3.4" } }));
    expectDeadline(configs[0]);
  });

  it("the deadline is KV_TIMEOUT_MS", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const { kvSignal, KV_TIMEOUT_MS } = await import("@/lib/platform/kv");
      kvSignal();
      expect(spy).toHaveBeenCalledWith(KV_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
});
