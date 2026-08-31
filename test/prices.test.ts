import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/monad/prices.ts had no test coverage before Step 2 — this module's
 * cache (PRICE_TTL_MS = 60s) is exactly the "existing cache architecture"
 * Step 2's tokenIntelligence.ts now reuses for market pricing instead of
 * introducing a new one, so its caching/staleness behavior is covered here
 * directly rather than only indirectly through the module that calls it.
 */

let simulateCallCount = 0;
// tokenIn is passed through so a test can make ONE specific token's probe
// behave differently (in particular, hang forever) while another resolves
// normally — see the "one stalled token" batch-pricing tests below. Existing
// single-token tests ignore the first argument.
let quoteFn: (tokenIn: string, amountInWei: bigint) => bigint | Promise<bigint> = () => 0n;

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    simulateContract: async ({ functionName, args }: { functionName: string; args: [{ tokenIn: string; amountIn: bigint }] }) => {
      simulateCallCount += 1;
      if (functionName === "quoteExactInputSingle") {
        const out = await quoteFn(args[0].tokenIn, args[0].amountIn);
        return { result: [out, 0n, 0, 0n] };
      }
      throw new Error(`unexpected simulateContract call: ${functionName}`);
    },
  }),
}));

let network: "mainnet" | "testnet" = "mainnet";
vi.mock("@/lib/monad/config", () => ({
  getNetwork: () => network,
}));

const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const RANDOM_TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  // prices.ts keeps a real module-level cache Map -- without resetting the
  // module registry, an entry set by one test (same RANDOM_TOKEN address)
  // would leak into the next and silently short-circuit its RPC calls.
  vi.resetModules();
  network = "mainnet";
  simulateCallCount = 0;
  quoteFn = () => 0n;
});

describe("getUsdPrice — freshness and caching", () => {
  it("USDC (the numeraire) always returns 1 without ever touching the chain", async () => {
    const { getUsdPrice } = await import("@/lib/monad/prices");
    const usd = await getUsdPrice(USDC, 6);
    expect(usd).toBe(1);
    expect(simulateCallCount).toBe(0);
  });

  it("a second call within the TTL is served from cache -- no repeat RPC calls (market data stays fresh, but a page rendering the same token twice doesn't double the cost)", async () => {
    quoteFn = (_tokenIn, wei) => wei; // 1:1 linear pool, no impact
    const { getUsdPrice } = await import("@/lib/monad/prices");
    await getUsdPrice(RANDOM_TOKEN, 18);
    const callsAfterFirst = simulateCallCount;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await getUsdPrice(RANDOM_TOKEN, 18);
    expect(simulateCallCount).toBe(callsAfterFirst); // no new RPC round-trips
  });

  it("a call after the TTL expires refreshes rather than serving stale data forever", async () => {
    quoteFn = (_tokenIn, wei) => wei;
    vi.useFakeTimers();
    try {
      const { getUsdPrice } = await import("@/lib/monad/prices");
      await getUsdPrice(RANDOM_TOKEN, 18);
      const callsAfterFirst = simulateCallCount;

      vi.advanceTimersByTime(61_000); // past the 60s TTL
      await getUsdPrice(RANDOM_TOKEN, 18);
      expect(simulateCallCount).toBeGreaterThan(callsAfterFirst); // genuinely re-fetched, not stale
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pool too shallow to trust (1-unit and 10-unit quotes diverge materially) reports null, never a misleading price", async () => {
    // A 1-unit probe implies a much higher unit price than a 10-unit probe --
    // the classic thin-pool signature this module's own docs describe.
    quoteFn = (_tokenIn, wei) => (wei <= 2_000000000000000000n ? wei * 100n : wei);
    const { getUsdPrice } = await import("@/lib/monad/prices");
    const usd = await getUsdPrice(RANDOM_TOKEN, 18);
    expect(usd).toBeNull();
  });

  it("no pool at all (every fee tier reverts) is null, never a fabricated zero", async () => {
    const { getUsdPrice } = await import("@/lib/monad/prices");
    const usd = await getUsdPrice(RANDOM_TOKEN, 18);
    expect(usd).toBeNull();
  });

  it("wrong network (testnet, Uniswap not deployed here) reports unavailable rather than guessing", async () => {
    network = "testnet";
    const { getUsdPrice } = await import("@/lib/monad/prices");
    const usd = await getUsdPrice(RANDOM_TOKEN, 18);
    expect(usd).toBeNull();
    expect(simulateCallCount).toBe(0);
  });
});

/**
 * A portfolio holding several tokens showed a real USD value for none of
 * them the moment ONE of those tokens' quoter probes stalled -- the provider
 * accepting the simulateContract call and simply never answering it, rather
 * than rejecting it (the exact failure class already fixed once for
 * portfolio-discovery's metadata reads). Promise.allSettled inside
 * quoteUnitPrice tolerates a REJECTED fee tier fine, but does nothing for one
 * that never settles, and getUsdPrices' own batch had no per-token bound
 * either -- so one bad quote blocked every other token's price in the same
 * request, not just its own.
 */
describe("getUsdPrices — one stalled token's quote must not block every other token's price", () => {
  const GOOD_TOKEN = "0xccccddddeeeeffff0000111122223333aaaabbbb";
  const STALLED_TOKEN = "0xddddeeeeffff0000111122223333aaaabbbbcccc";

  it("returns the working token's real price and null for the stalled one, without waiting out a real production timeout", async () => {
    quoteFn = (tokenIn, wei) => {
      if (tokenIn.toLowerCase() === STALLED_TOKEN) return new Promise(() => {}); // a dead/stalled quoter -- never answers
      // A linear $1-per-unit pool for the good token: 18-decimal input scaled
      // down to USDC's 6 decimals, no price impact between the 1-unit and
      // 10-unit probes.
      return wei / 10n ** 12n;
    };
    const { getUsdPrices } = await import("@/lib/monad/prices");

    const started = Date.now();
    const prices = await getUsdPrices([
      { address: GOOD_TOKEN, decimals: 18 },
      { address: STALLED_TOKEN, decimals: 18 },
    ]);
    expect(prices[GOOD_TOKEN.toLowerCase()]).toBe(1); // 1 unit in, 1 unit out of a USDC-denominated pool
    expect(prices[STALLED_TOKEN.toLowerCase()]).toBeNull();
    expect(Date.now() - started, "must not have waited out a real production-length timeout").toBeLessThan(8_000);
  }, 10_000);
});
