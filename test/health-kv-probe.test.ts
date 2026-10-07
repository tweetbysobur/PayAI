import { beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The temporary KV probe: one disposable SET NX EX / GET / DEL / GET cycle.
 * getRedis() is replaced by a recording fake; nothing real is contacted.
 */
interface Fake {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  [k: string]: unknown;
}

let redis: Fake | null = null;
let store: Map<string, unknown>;

vi.mock("@/lib/platform/kv", () => ({ getRedis: async () => redis }));

function healthyFake(): Fake {
  store = new Map();
  return {
    set: vi.fn(async (k: string, v: unknown, o?: { nx?: boolean }) => {
      if (o?.nx && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    }),
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

async function call() {
  const mod = await import("@/app/api/health/kv/route");
  const res = await mod.GET();
  return { res, text: await res.clone().text(), json: await res.json(), mod };
}

const ALLOWED_BODIES = [{ ok: true, storage: "shared_kv" }, { ok: false, storage: "unavailable" }];

beforeEach(() => {
  redis = healthyFake();
});

describe("GET /api/health/kv", () => {
  it("503 and a safe body when KV is unavailable", async () => {
    redis = null;
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(json).toEqual({ ok: false, storage: "unavailable" });
  });

  it("200 on a full write/read/delete cycle, ending with a confirmed-absent key", async () => {
    const { res, json } = await call();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, storage: "shared_kv" });
    const r = redis!;
    expect(r.set).toHaveBeenCalledTimes(1);
    const [key, value, opts] = r.set.mock.calls[0];
    expect(key).toMatch(/^payai_kv_probe:[0-9a-f]{32}$/);
    expect(typeof value).toBe("string");
    expect(opts).toEqual({ nx: true, ex: 30 });
    expect(r.get).toHaveBeenCalledTimes(2);
    expect(r.get.mock.calls.every((c) => c[0] === key)).toBe(true);
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.del).toHaveBeenCalledWith(key);
    expect(store.size).toBe(0);
  });

  it("uses a fresh key and value each call", async () => {
    await call();
    await call();
    const [a, b] = redis!.set.mock.calls;
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
  });

  it("503 when the write throws, with no error detail", async () => {
    redis!.set.mockRejectedValue(new Error("https://secret-host.upstash.io token=abc"));
    const { res, text, json } = await call();
    expect(res.status).toBe(503);
    expect(json).toEqual({ ok: false, storage: "unavailable" });
    expect(text).not.toMatch(/upstash|secret|token/i);
  });

  it("503 when the NX write does not succeed (key existed)", async () => {
    redis!.set.mockResolvedValue(null);
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(json).toEqual({ ok: false, storage: "unavailable" });
    expect(redis!.get).not.toHaveBeenCalled();
  });

  it("503 on a read mismatch, and still attempts cleanup", async () => {
    redis!.get.mockResolvedValue("something-else");
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(json).toEqual({ ok: false, storage: "unavailable" });
    expect(redis!.del).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it("503 when the delete throws, retrying cleanup once in finally", async () => {
    redis!.del.mockRejectedValue(new Error("boom"));
    const { res, text } = await call();
    expect(res.status).toBe(503);
    expect(text).not.toContain("boom");
    expect(redis!.del).toHaveBeenCalledTimes(2);
  });

  it("503 when the key still exists after the delete", async () => {
    redis!.del.mockResolvedValue(1); // claims success but removes nothing
    const { res } = await call();
    expect(res.status).toBe(503);
    expect(redis!.del).toHaveBeenCalledTimes(2);
  });

  it("503 when the post-write read throws, with cleanup attempted", async () => {
    redis!.get.mockRejectedValue(new Error("net"));
    const { res } = await call();
    expect(res.status).toBe(503);
    expect(redis!.del).toHaveBeenCalledTimes(1);
  });

  it("is GET-only: no other method handler is exported", async () => {
    const mod = (await import("@/app/api/health/kv/route")) as Record<string, unknown>;
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(mod[m]).toBeUndefined();
    expect(typeof mod.GET).toBe("function");
  });

  it("is never cacheable and always dynamic", async () => {
    for (const setup of [() => {}, () => { redis = null; }, () => { redis!.set.mockResolvedValue(null); }]) {
      redis = healthyFake();
      setup();
      const { res } = await call();
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const mod = await import("@/app/api/health/kv/route");
    expect(mod.dynamic).toBe("force-dynamic");
  });

  it("never puts the probe key, value or anything else in the response", async () => {
    for (const mutate of [() => {}, () => { redis!.get.mockResolvedValue("x"); }, () => { redis = null; }]) {
      redis = healthyFake();
      mutate();
      const { text, json } = await call();
      const [key, value] = redis?.set.mock.calls[0] ?? [];
      if (key) expect(text).not.toContain(String(key));
      if (value) expect(text).not.toContain(String(value));
      expect(text).not.toContain("payai_kv_probe");
      expect(ALLOWED_BODIES).toContainEqual(json);
    }
  });

  it("touches only the probe key: one distinct key across every operation", async () => {
    await call();
    const keys = new Set([...redis!.set.mock.calls, ...redis!.get.mock.calls, ...redis!.del.mock.calls].map((c) => c[0]));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^payai_kv_probe:/);
  });

  it("only calls set/get/del on the shared client (nothing else of the platform's surface)", async () => {
    const touched: string[] = [];
    const base = healthyFake();
    redis = new Proxy(base, {
      get(t, p: string) {
        touched.push(p);
        return t[p];
      },
    }) as Fake;
    await call();
    // "then" is only the promise machinery probing the proxy as it is awaited.
    expect(new Set(touched.filter((p) => p !== "then"))).toEqual(new Set(["set", "get", "del"]));
  });

  it("source: uses getRedis, builds no client, reads no env, no Math.random, not imported elsewhere", () => {
    const root = join(__dirname, "..");
    const src = readFileSync(join(root, "app/api/health/kv/route.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toContain("getRedis");
    for (const bad of ["@upstash/redis", "new Redis", "process.env", "Math.random", "KV_REST_API", "req.", "request", "searchParams", "cookies"]) {
      expect(code).not.toContain(bad);
    }
    for (const dir of ["lib", "components"]) {
      const out = execSync(`grep -rl "api/health/kv" ${dir} || true`, { cwd: root }).toString();
      expect(out.trim()).toBe("");
    }
  });
});
