import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeFunctionData, getAddress, pad, parseAbi, type Hex } from "viem";
import { grantCookieFor } from "./walletGrantCookie";

/**
 * R4 — payment-path storage fails CLOSED in production.
 *
 * Approvals (/api/agent), confirmation claims and results and the payment's
 * log row (/api/agent/confirm) must live in shared KV. In production a
 * missing KV config, a KV client that can't be created, or a failing KV call
 * is a 503 "storage unavailable" — never a silent fall-back to one
 * instance's memory, and never mistaken for "approval not found".
 *
 * MOCKED: @upstash/redis is replaced by an in-memory fake with per-operation
 * failure switches (and an import-failure switch), so the real lib/platform
 * kv.ts / idempotency.ts / store.ts and both routes run against it. The chain
 * client, wallet balance checks and fee-terms read are mocked as in the
 * existing route tests. Nothing is signed or sent.
 */

vi.setConfig({ testTimeout: 20_000 });

const WALLET = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const RECIPIENT = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TX = `0x${"ab".repeat(32)}` as Hex;
const ONE = 1_000_000n;
const TRANSFER_DATA = encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), functionName: "transfer", args: [RECIPIENT, ONE] });
const SEND = `Send 1 USDC to ${RECIPIENT}`;

/* ── fake Upstash ─────────────────────────────────────────────────────── */
const kv = {
  data: new Map<string, unknown>(),
  importFails: false,
  fail: { get: false, setNx: false, set: false, del: false, lpush: false },
};
const boom = (op: string) => Promise.reject(new Error(`Upstash ${op} failed (mocked)`));
// The client "can't be created" via its constructor rather than by failing
// the import itself: vitest caches a mock factory's result across
// vi.resetModules(), so a throwing factory can't be toggled per test. Both
// happen inside the same try in lib/platform/kv.ts getRedis(), so it is the
// same client_unavailable path.
vi.mock("@upstash/redis", () => {
  class Redis {
    constructor() {
      if (kv.importFails) throw new Error("cannot create the @upstash/redis client (mocked)");
    }
    async get(k: string) { return kv.fail.get ? boom("GET") : structuredClone(kv.data.get(k) ?? null); }
    async set(k: string, v: unknown, o?: { nx?: boolean; ex?: number }) {
      if (o?.nx) {
        if (kv.fail.setNx) return boom("SET NX");
        if (kv.data.has(k)) return null;
      } else if (kv.fail.set) return boom("SET");
      kv.data.set(k, structuredClone(v));
      return "OK";
    }
    async del(k: string) { if (kv.fail.del) return boom("DEL"); kv.data.delete(k); return 1; }
    async lpush(k: string, v: unknown) {
      if (kv.fail.lpush) return boom("LPUSH");
      const l = (kv.data.get(k) as unknown[] | undefined) ?? [];
      kv.data.set(k, [structuredClone(v), ...l]);
      return l.length + 1;
    }
    async ltrim(k: string, s: number, e: number) { const l = (kv.data.get(k) as unknown[] | undefined) ?? []; kv.data.set(k, l.slice(s, e + 1)); return "OK"; }
    async lrange(k: string, s: number, e: number) { const l = (kv.data.get(k) as unknown[] | undefined) ?? []; return l.slice(s, e < 0 ? undefined : e + 1); }
    // The rate limiter's counters (lib/platform/ratelimit.ts) — never failed here.
    async incr(k: string) { const n = Number(kv.data.get(k) ?? 0) + 1; kv.data.set(k, n); return n; }
    async expire() { return 1; }
  }
  return { Redis };
});

/* ── chain + pipeline mocks (as in the existing route tests) ──────────── */
const chain = { receipt: null as unknown, tx: null as unknown };
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: async () => { if (!chain.receipt) throw new actual.TransactionReceiptNotFoundError({ hash: TX }); return chain.receipt; },
      getTransaction: async () => chain.tx,
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    }),
  };
});
vi.mock("@/lib/monad/balance", async (orig) => ({ ...(await orig<typeof import("@/lib/monad/balance")>()), insufficientBalanceReason: async () => null, insufficientWithFeeReason: async () => null }));
vi.mock("@/lib/sdk/fees", async (orig) => ({ ...(await orig<typeof import("@/lib/sdk/fees")>()), readPlatformFeeTerms: async () => ({ feeBps: 25 }) }));
vi.mock("@/lib/payment/sanctions", async (orig) => ({ ...(await orig<typeof import("@/lib/payment/sanctions")>()), ensureSanctionsLoaded: async () => {} }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("MONAD_NETWORK", "mainnet");
  vi.stubEnv("MONAD_MAINNET_USDC", USDC);
  vi.stubEnv("PAYAI_FORWARDER_ENABLED", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  // Wallet grants are signed with this; production refuses to sign without it.
  vi.stubEnv("AUTH_SESSION_SECRET", "test-only-session-secret");
  kv.data.clear();
  kv.importFails = false;
  Object.keys(kv.fail).forEach((k) => (kv.fail[k as keyof typeof kv.fail] = false));
  chain.receipt = null;
  chain.tx = null;
  (globalThis as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  (globalThis as { __veripayMem?: Map<string, unknown> }).__veripayMem?.clear();
});
afterEach(() => vi.unstubAllEnvs());

const production = () => vi.stubEnv("NODE_ENV", "production");
const withKv = () => { vi.stubEnv("KV_REST_API_URL", "https://kv.example.invalid"); vi.stubEnv("KV_REST_API_TOKEN", "test-token"); };
const withoutKv = () => { vi.stubEnv("KV_REST_API_URL", ""); vi.stubEnv("KV_REST_API_TOKEN", ""); };
const memIdem = () => (globalThis as { __veripayIdem?: Map<string, unknown> }).__veripayIdem;
const memLog = () => (globalThis as { __veripayMem?: Map<string, unknown> }).__veripayMem;

type Body = Record<string, unknown> & { state?: string; reason?: string; error?: string; unsignedTx?: unknown; decision?: string };
const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": `10.6.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...grantCookieFor((body as { walletAddress?: unknown }).walletAddress) },
  body: JSON.stringify(body),
});
async function agent(idempotencyKey = "k-1") {
  const { POST } = await import("@/app/api/agent/route");
  const res = await POST(req("/api/agent", { intent: SEND, walletAddress: WALLET, idempotencyKey }));
  return { status: res.status, body: (await res.json()) as Body };
}
async function confirm(requestId?: string) {
  const { POST } = await import("@/app/api/agent/confirm/route");
  const res = await POST(req("/api/agent/confirm", { rawText: SEND, walletAddress: WALLET, txHash: TX, ...(requestId ? { requestId } : {}) }));
  return { status: res.status, body: (await res.json()) as Body };
}
function mineSuccess() {
  chain.tx = { hash: TX, from: WALLET, to: USDC, input: TRANSFER_DATA, value: 0n };
  chain.receipt = {
    status: "success", from: WALLET, to: USDC, blockNumber: 7n, gasUsed: 50_000n, effectiveGasPrice: 1n,
    logs: [{ address: USDC, topics: [TRANSFER, pad(WALLET), pad(RECIPIENT)], data: pad(`0x${ONE.toString(16)}`) }],
  };
}
const kvTxLog = () => (kv.data.get("veripay:demo:txlog") as { txHash?: string }[] | undefined) ?? [];
const PAY_AGAIN = /start (the|a new) payment|pay again|(?<!don't )send it again|retry the payment/i;

/* ── 1. the durable accessor ──────────────────────────────────────────── */
describe("getDurableRedis: configuration vs runtime failures", () => {
  it("production + KV not configured → not_configured (the legacy accessor still returns null)", async () => {
    production(); withoutKv();
    const k = await import("@/lib/platform/kv");
    await expect(k.getDurableRedis()).rejects.toMatchObject({ name: "StorageUnavailableError", failure: "not_configured" });
    expect(await k.getRedis()).toBeNull();
  });

  it("production + KV configured but its client can't be created → client_unavailable", async () => {
    production(); withKv(); kv.importFails = true;
    const k = await import("@/lib/platform/kv");
    await expect(k.getDurableRedis()).rejects.toMatchObject({ failure: "client_unavailable" });
  });

  it("outside production, a CONFIGURED but broken KV still fails closed (never silently memory)", async () => {
    withKv(); kv.importFails = true; // NODE_ENV is "test" here
    const k = await import("@/lib/platform/kv");
    await expect(k.getDurableRedis()).rejects.toMatchObject({ failure: "client_unavailable" });
  });

  it("outside production with NO KV configured → null: the documented in-memory dev/test mode", async () => {
    withoutKv();
    expect(process.env.NODE_ENV).not.toBe("production");
    const k = await import("@/lib/platform/kv");
    expect(await k.getDurableRedis()).toBeNull();
  });

  it("production + KV configured and healthy → the shared client", async () => {
    production(); withKv();
    const k = await import("@/lib/platform/kv");
    expect(await k.getDurableRedis()).not.toBeNull();
  });
});

describe("idempotency + store: durable calls never fall back, and failures are typed", () => {
  it("production without KV: durable claim/peek/complete/record throw; non-durable callers are unchanged", async () => {
    production(); withoutKv();
    const idem = await import("@/lib/platform/idempotency");
    const store = await import("@/lib/platform/store");
    const D = { durable: true } as const;
    await expect(idem.claimRequest("x", D)).rejects.toMatchObject({ failure: "not_configured" });
    await expect(idem.peekRequestRecord("x", D)).rejects.toMatchObject({ failure: "not_configured" });
    await expect(idem.completeRequest("x", {}, D)).rejects.toMatchObject({ failure: "not_configured" });
    await expect(store.recordTx("demo", { decision: "executed", action: "send_payment", feature: "payment", amount: 1, token: "USDC", recipient: RECIPIENT, domain: null, sender: WALLET, riskScore: 0, compliance: "approved", summary: "x" }, D)).rejects.toMatchObject({ failure: "not_configured" });
    expect(memIdem()?.size ?? 0).toBe(0);
    // Not part of R4's scope: other features' best-effort calls keep using memory.
    expect((await idem.claimRequest("legacy")).claimed).toBe(true);
  });

  it("a failing KV read is operation_failed — never null ('no record')", async () => {
    production(); withKv();
    const idem = await import("@/lib/platform/idempotency");
    expect(await idem.peekRequestRecord("absent", { durable: true })).toBeNull(); // genuinely missing
    kv.fail.get = true;
    await expect(idem.peekRequestRecord("absent", { durable: true })).rejects.toMatchObject({ name: "StorageUnavailableError", failure: "operation_failed" });
  });
});

/* ── 2. /api/agent: approvals ─────────────────────────────────────────── */
describe("/api/agent approval creation fails closed", () => {
  it("production without KV → 503, nothing to sign, nothing in memory", async () => {
    production(); withoutKv();
    const r = await agent();
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    expect(r.body.unsignedTx).toBeUndefined();
    expect(r.body.error).toMatch(/nothing was sent/i);
    expect(memIdem()?.size ?? 0).toBe(0);
  });

  it("KV client can't be created → 503, nothing to sign", async () => {
    production(); withKv(); kv.importFails = true;
    const r = await agent();
    expect(r.status).toBe(503);
    expect(r.body.unsignedTx).toBeUndefined();
  });

  it("KV claim fails → 503, nothing to sign", async () => {
    production(); withKv(); kv.fail.setNx = true;
    const r = await agent();
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    expect(r.body.unsignedTx).toBeUndefined();
  });

  it("storing the APPROVAL fails → 503 and NO unsignedTx (the wallet is never asked to sign an unrecorded approval)", async () => {
    production(); withKv(); kv.fail.set = true; // claim (SET NX) works, the approval write (SET) fails
    const r = await agent();
    expect(r.status).toBe(503);
    expect(r.body.unsignedTx).toBeUndefined();
    expect(r.body.decision).toBeUndefined();
    expect(r.body.error).toMatch(/nothing was sent/i);
    expect([...kv.data.keys()].filter((k) => k.startsWith("veripay:idem:agent-req:"))).toHaveLength(0); // claim released
  });

  it("healthy KV in production → the approval is in KV, not memory", async () => {
    production(); withKv();
    const r = await agent();
    expect(r.body.decision).toBe("ready_to_sign");
    expect([...kv.data.keys()].some((k) => k.startsWith("veripay:idem:agent-req:"))).toBe(true);
    expect(memIdem()?.size ?? 0).toBe(0);
  });
});

/* ── 3. /api/agent/confirm ────────────────────────────────────────────── */
describe("/api/agent/confirm fails closed and never calls a storage failure 'approval not found'", () => {
  it("production without KV → 503 store_unavailable (not approval_not_found)", async () => {
    production(); withoutKv(); mineSuccess();
    const r = await confirm("k-1");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    expect(r.body.reason).toBeUndefined();
    expect(r.body.error).not.toMatch(PAY_AGAIN);
    expect(r.body.error).toMatch(/don't send it again/i);
  });

  it("KV client can't be created → 503 store_unavailable", async () => {
    production(); withKv(); kv.importFails = true; mineSuccess();
    expect((await confirm("k-1")).body.state).toBe("store_unavailable");
  });

  it("claim fails → 503 store_unavailable", async () => {
    production(); withKv(); mineSuccess();
    kv.fail.setNx = true;
    expect((await confirm("k-1")).body.state).toBe("store_unavailable");
  });

  it("approval LOOKUP fails → 503 store_unavailable, claim released, then a retry confirms", async () => {
    production(); withKv();
    expect((await agent("k-2")).body.decision).toBe("ready_to_sign");
    mineSuccess();
    kv.fail.get = true;
    const r = await confirm("k-2");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    expect(r.body.reason).toBeUndefined();
    expect(kv.data.has(`veripay:idem:agent-confirm:${TX}`)).toBe(false);
    kv.fail.get = false;
    expect((await confirm("k-2")).body.state).toBe("confirmed");
  });

  it("a GENUINELY missing approval (KV healthy) is still settled_unmatched / approval_not_found", async () => {
    production(); withKv(); mineSuccess();
    const r = await confirm("never-created");
    expect(r.body).toMatchObject({ state: "settled_unmatched", reason: "approval_not_found" });
  });

  it("the log write fails → 503, claim released, retry records once in KV", async () => {
    production(); withKv();
    await agent("k-3");
    mineSuccess();
    kv.fail.lpush = true;
    const r = await confirm("k-3");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    expect(kvTxLog()).toHaveLength(0);
    kv.fail.lpush = false;
    expect((await confirm("k-3")).body.state).toBe("confirmed");
    expect(kvTxLog().filter((t) => t.txHash === TX)).toHaveLength(1);
    expect(memLog()?.size ?? 0).toBe(0); // never in memory
  });

  it("completion fails AFTER the log write → 503 'recorded', claim kept, no second row", async () => {
    production(); withKv();
    await agent("k-4");
    mineSuccess();
    kv.fail.set = true; // the final confirmation write (plain SET)
    const r = await confirm("k-4");
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/confirmed and recorded/i);
    expect(kvTxLog().filter((t) => t.txHash === TX)).toHaveLength(1);
    kv.fail.set = false;
    expect((await confirm("k-4")).body.state).toBe("in_progress");
    expect(kvTxLog().filter((t) => t.txHash === TX)).toHaveLength(1);
  });

  it("healthy KV in production: the whole approval → confirm flow lives in KV", async () => {
    production(); withKv();
    await agent("k-5");
    mineSuccess();
    const r = await confirm("k-5");
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("confirmed");
    expect(kv.data.has(`veripay:idem:agent-confirm:${TX}`)).toBe(true);
    expect(kvTxLog().filter((t) => t.txHash === TX)).toHaveLength(1);
    expect(memIdem()?.size ?? 0).toBe(0);
    expect(memLog()?.size ?? 0).toBe(0);
  });
});

/* ── 4. dev / test mode is intentional ────────────────────────────────── */
describe("development and tests keep the documented in-memory mode", () => {
  it("NODE_ENV≠production and no KV: approval → confirm works in memory", async () => {
    withoutKv();
    expect((await agent("dev-1")).body.decision).toBe("ready_to_sign");
    mineSuccess();
    expect((await confirm("dev-1")).body.state).toBe("confirmed");
    expect(memIdem()?.size ?? 0).toBeGreaterThan(0);
  });
});
