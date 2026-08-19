import { afterEach, describe, expect, it, vi } from "vitest";

/** Same mockFetch pattern as test/ask-orchestrate.test.ts — record every
 *  call and respond with a real Response object, so getDexScreenerSnapshot
 *  is exercised through the actual fetch/AbortSignal/JSON-parsing path it
 *  uses in production, not a stubbed-out shortcut. */
function mockFetch(responder: (url: string) => { status?: number; ok?: boolean; body: unknown } | "throw") {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const r = responder(String(url));
    if (r === "throw") throw new Error("network unreachable");
    return new Response(JSON.stringify(r.body), { status: r.status ?? (r.ok === false ? 500 : 200) });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

let network: "mainnet" | "testnet" = "mainnet";
vi.mock("@/lib/monad/config", () => ({ getNetwork: () => network }));

afterEach(() => {
  vi.restoreAllMocks();
  network = "mainnet";
});

const TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";

function pair(overrides: Record<string, unknown> = {}) {
  return {
    liquidity: { usd: 50_000 },
    volume: { h24: 12_345.67 },
    priceChange: { h24: 5.12 },
    txns: { h24: { buys: 30, sells: 12 } },
    ...overrides,
  };
}

describe("getDexScreenerSnapshot", () => {
  it("never fetches on testnet -- no Monad testnet chain slug was ever verified", async () => {
    network = "testnet";
    const { calls, restore } = mockFetch(() => ({ body: [pair()] }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      const r = await getDexScreenerSnapshot(TOKEN as `0x${string}`);
      expect(r).toBeNull();
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });

  it("requests the token-scoped v1 endpoint with the monad chain slug and this exact address", async () => {
    const { calls, restore } = mockFetch(() => ({ body: [pair()] }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      await getDexScreenerSnapshot(TOKEN as `0x${string}`);
      expect(calls).toEqual([`https://api.dexscreener.com/tokens/v1/monad/${TOKEN}`]);
    } finally { restore(); }
  });

  it("maps a real pair response to volume/transactions/buys/sells/priceChange", async () => {
    const { restore } = mockFetch(() => ({ body: [pair()] }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      const r = await getDexScreenerSnapshot(TOKEN as `0x${string}`);
      expect(r).toEqual({
        volume24h: 12_345.67,
        transactions24h: 42,
        buys24h: 30,
        sells24h: 12,
        priceChange24h: 0.0512, // fraction, not the raw percent -- see this module's own doc
      });
    } finally { restore(); }
  });

  it("picks the most liquid pair when the token has several", async () => {
    const { restore } = mockFetch(() => ({
      body: [
        pair({ liquidity: { usd: 500 }, volume: { h24: 1 } }),
        pair({ liquidity: { usd: 999_999 }, volume: { h24: 777 } }), // the real, dominant pool
        pair({ liquidity: { usd: 10_000 }, volume: { h24: 2 } }),
      ],
    }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      const r = await getDexScreenerSnapshot(TOKEN as `0x${string}`);
      expect(r?.volume24h).toBe(777);
    } finally { restore(); }
  });

  it("returns null, never throws, when nothing is indexed for this token yet (empty array -- e.g. a fresh bonding-curve launch)", async () => {
    const { restore } = mockFetch(() => ({ body: [] }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      await expect(getDexScreenerSnapshot(TOKEN as `0x${string}`)).resolves.toBeNull();
    } finally { restore(); }
  });

  it("returns null on a non-2xx response, never fabricating a zero snapshot", async () => {
    const { restore } = mockFetch(() => ({ ok: false, status: 404, body: { error: "not found" } }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      await expect(getDexScreenerSnapshot(TOKEN as `0x${string}`)).resolves.toBeNull();
    } finally { restore(); }
  });

  it("returns null on a malformed (non-array) response body", async () => {
    const { restore } = mockFetch(() => ({ body: { pairs: [pair()] } })); // wrapped, not the bare array this endpoint actually returns
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      await expect(getDexScreenerSnapshot(TOKEN as `0x${string}`)).resolves.toBeNull();
    } finally { restore(); }
  });

  it("returns null when the best pair has no numeric 24h volume, rather than reporting a partial/fabricated snapshot", async () => {
    const { restore } = mockFetch(() => ({ body: [pair({ volume: {} })] }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      await expect(getDexScreenerSnapshot(TOKEN as `0x${string}`)).resolves.toBeNull();
    } finally { restore(); }
  });

  it("volume/priceChange can be present while txns is missing -- transactions24h/buys24h/sells24h fall back to null individually, not the whole snapshot", async () => {
    const { restore } = mockFetch(() => ({ body: [pair({ txns: {} })] }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      const r = await getDexScreenerSnapshot(TOKEN as `0x${string}`);
      expect(r?.volume24h).toBe(12_345.67);
      expect(r?.transactions24h).toBeNull();
      expect(r?.buys24h).toBeNull();
      expect(r?.sells24h).toBeNull();
    } finally { restore(); }
  });

  it("priceChange24h is null, not 0, when DexScreener doesn't report one for this pair", async () => {
    const { restore } = mockFetch(() => ({ body: [pair({ priceChange: {} })] }));
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      const r = await getDexScreenerSnapshot(TOKEN as `0x${string}`);
      expect(r?.priceChange24h).toBeNull();
    } finally { restore(); }
  });

  it("fails open to null on a network error, never throws and breaks the rest of a token lookup", async () => {
    const { restore } = mockFetch(() => "throw");
    try {
      const { getDexScreenerSnapshot } = await import("@/lib/monad/dexscreener");
      await expect(getDexScreenerSnapshot(TOKEN as `0x${string}`)).resolves.toBeNull();
    } finally { restore(); }
  });
});
