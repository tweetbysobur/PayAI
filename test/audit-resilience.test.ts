import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CHUNK_RELOAD_WINDOW_MS, isChunkLoadError, mayAutoReload } from "@/lib/platform/chunkReload";

/**
 * Regressions from the production error log (Oct 2026):
 *  - /api/onchain and /api/wallet-intelligence hung until the 300 s platform
 *    timeout when the RPC was slow;
 *  - a tab open across a deploy crashed on ChunkLoadError and "Try again"
 *    could never recover it.
 */

describe("stale-deploy recovery", () => {
  it("recognises chunk load failures from Turbopack, webpack and Vite-style messages", () => {
    expect(isChunkLoadError({ name: "ChunkLoadError", message: "x" })).toBe(true);
    expect(isChunkLoadError({ message: "Failed to load chunk /_next/static/chunks/0853un-p6_ite.js from module 964893" })).toBe(true);
    expect(isChunkLoadError({ message: "Loading chunk 123 failed." })).toBe(true);
    expect(isChunkLoadError({ message: "Failed to fetch dynamically imported module: https://x/y.js" })).toBe(true);
    expect(isChunkLoadError({ message: "Cannot read properties of undefined" })).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
  it("reloads at most once a minute, so a broken file can't loop", () => {
    const now = 1_000_000;
    expect(mayAutoReload(null, now)).toBe(true);
    expect(mayAutoReload(now - 5_000, now)).toBe(false);
    expect(mayAutoReload(now - CHUNK_RELOAD_WINDOW_MS - 1, now)).toBe(true);
    expect(mayAutoReload(Number.NaN, now)).toBe(true);
  });
  it("the error boundary reloads instead of re-rendering for a stale deploy", () => {
    const src = readFileSync("app/error.tsx", "utf8");
    expect(src).toMatch(/if \(mayAutoReload\(last \|\| null, Date\.now\(\)\)\) \{\s*sessionStorage\.setItem\(CHUNK_RELOAD_KEY/);
    expect(src).toMatch(/onClick=\{\(\) => \(stale \? location\.reload\(\) : reset\(\)\)\}/);
  });
});

/* ── /api/onchain: a hung read no longer holds the response ─────────────── */

const ctl = vi.hoisted(() => ({ hang: new Set<string>(), requestsLimit: undefined as number | undefined }));
vi.mock("@/lib/monad/contracts", () => {
  const never = <T,>() => new Promise<T>(() => {});
  return {
    executorEnabled: () => true,
    getOnchainStats: () => (ctl.hang.has("stats") ? never() : Promise.resolve({ payments: 1, volume: 0, approved: 1, rejected: 0, requests: 0 })),
    getOnchainPayments: () => (ctl.hang.has("payments") ? never() : Promise.resolve([])),
    getOnchainMerchants: () => Promise.resolve(Array.from({ length: 150 }, (_, i) => ({ wallet: `0x${i}`, name: "m", active: true, volume: 0, paymentCount: 0, registeredAt: 0 }))),
    getOnchainRequests: (limit?: number) => { ctl.requestsLimit = limit; return ctl.hang.has("requests") ? never() : Promise.resolve([]); },
  };
});
vi.mock("@/lib/monad/config", () => ({
  explorerTx: (h: string) => `https://explorer/tx/${h}`,
  explorerAddress: (a: string) => `https://explorer/address/${a}`,
  getPaymentExecutor: () => "0x00000000000000000000000000000000000000e1",
  getMerchantRegistry: () => null,
  getPayAIForwarder: () => null,
  getPayAITradeExecutor: () => null,
  getAutomationVault: () => null,
  tradeExecutorEnabled: () => false,
}));

describe("GET /api/onchain", () => {
  afterEach(() => { ctl.hang.clear(); vi.useRealTimers(); });

  it("answers within the read budget when RPC reads hang, still with the contract addresses", async () => {
    vi.useFakeTimers();
    ctl.hang.add("stats"); ctl.hang.add("requests");
    const { GET } = await import("@/app/api/onchain/route");
    const p = GET();
    await vi.advanceTimersByTimeAsync(10_500);
    const j = await (await p).json();
    expect(j.configured).toBe(true);
    expect(j.contracts.paymentExecutor).toBe("0x00000000000000000000000000000000000000e1");
    expect(j.stats).toBeNull();
    expect(j.requests).toEqual([]);
    expect(j.unavailable.sort()).toEqual(["requests", "stats"]);
  });

  it("caps invoices and merchants to the most recent 100", async () => {
    const { GET } = await import("@/app/api/onchain/route");
    const j = await (await GET()).json();
    expect(ctl.requestsLimit).toBe(100);
    expect(j.merchants).toHaveLength(100);
    expect(j.unavailable).toBeUndefined();
  });
});

describe("wallet intelligence", () => {
  it("the route has an overall budget and the fallback log scan is bounded", () => {
    const route = readFileSync("app/api/wallet-intelligence/route.ts", "utf8");
    expect(route).toMatch(/withTimeout\(getWalletIntelligence\(address as `0x\$\{string\}`\), 25_000, null\)/);
    expect(route).toMatch(/status: 504/);
    const intel = readFileSync("lib/monad/wallet-intel.ts", "utf8");
    expect(intel).toMatch(/return await withTimeout\(\(async \(\) => \{\s*const latest = await pub\.getBlockNumber\(\);/);
  });
});
