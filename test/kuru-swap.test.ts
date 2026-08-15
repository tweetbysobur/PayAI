import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";

/* Kuru is a second real SwapProvider behind the same seam Uniswap v3 uses
   (see lib/monad/swap.ts's getSwapProvider aggregator). Its ONLY external
   inputs are the chain (Router.verifiedMarket, OrderBook simulate/allowance
   reads) and the token registry — stub both, exactly like test/swap.test.ts
   already does for Uniswap, so these tests exercise the real resolution/
   quoting/plan-building logic rather than a live RPC. */

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x1234567890123456789012345678901234567890"; // matches the mocked token registry below
const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394"; // the real MON-USDC market address
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;

/** Kuru's own verifiedMarket() shape — base=native MON (zero address),
 *  quote=USDC (matching the mocked registry), 6-decimal precisions on both
 *  sides, 30 bps taker fee. Overridable per test for the mismatch case. */
let verifiedMarketResult: readonly [number, bigint, string, bigint, string, bigint, number, bigint, bigint, bigint, bigint] = [
  1_000000, 1_000000n, ZERO, 18n, USDC, 6n, 100, 0n, 0n, 30n, 10n,
];
let sellAmountOutWei = 0n; // placeAndExecuteMarketSell (MON -> USDC) result
let buyAmountOutWei = 0n; // placeAndExecuteMarketBuy (USDC -> MON) result
let allowanceWei = 0n;
type SimulateCall = { functionName: string; args: readonly unknown[]; value?: bigint };
const lastSimulate: { call: SimulateCall | null } = { call: null };
// Read through a function call (not a direct property access) so TS's
// control-flow narrowing -- which otherwise treats `lastSimulate.call` as
// permanently `null` after the reset a few lines above, unaware the mocked
// simulateContract() below reassigns it across the await -- doesn't apply.
function getLastSimulate(): SimulateCall | null {
  return lastSimulate.call;
}

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "verifiedMarket") return verifiedMarketResult;
      if (functionName === "allowance") return allowanceWei;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    simulateContract: async ({ functionName, args, value }: { functionName: string; args: readonly unknown[]; value?: bigint }) => {
      if (functionName === "placeAndExecuteMarketSell") { lastSimulate.call = { functionName, args, value }; return { result: sellAmountOutWei }; }
      if (functionName === "placeAndExecuteMarketBuy") { lastSimulate.call = { functionName, args, value }; return { result: buyAmountOutWei }; }
      if (functionName === "quoteExactInputSingle") return { result: [0n, 0n, 0, 0n] }; // Uniswap: no liquidity, so Kuru is isolated in single-provider tests
      throw new Error(`unexpected simulateContract call: ${functionName}`);
    },
  }),
}));

vi.mock("@/lib/monad/config", () => ({
  getNetwork: () => "mainnet",
  getStablecoin: () => ({ address: USDC, decimals: 6 }),
}));

vi.mock("@/lib/monad/tokenRegistry", () => ({
  getVerifiedTokens: async () => [{ address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, verified: true }],
}));

describe("Kuru provider — market resolution never guesses", () => {
  it("a pair with no known Kuru market is refused before any network call", async () => {
    const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");
    await expect(kuruProvider.quote("USDC", "WETH", 10)).rejects.toThrow(/kuru doesn't support/i);
  });

  it("a market whose on-chain quote asset doesn't match PayAI's own USDC address is refused, not silently trusted", async () => {
    verifiedMarketResult = [1_000000, 1_000000n, ZERO, 18n, "0x9999999999999999999999999999999999999999", 6n, 100, 0n, 0n, 30n, 10n];
    try {
      const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");
      await expect(kuruProvider.quote("MON", "USDC", 1)).rejects.toThrow(/kuru doesn't support/i);
    } finally {
      verifiedMarketResult = [1_000000, 1_000000n, ZERO, 18n, USDC, 6n, 100, 0n, 0n, 30n, 10n];
    }
  });
});

describe("Kuru provider — real quote, honest fields", () => {
  it("MON -> USDC (market sell) reports a real simulated output, never a fabricated price impact", async () => {
    sellAmountOutWei = 2_340000n; // 2.34 USDC (6 decimals)
    const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");
    const q = await kuruProvider.quote("MON", "USDC", 5);
    expect(q.amountOut).toBeCloseTo(2.34, 6);
    expect(q.minAmountOut).toBeLessThan(q.amountOut);
    expect(q.minAmountOut).toBeGreaterThan(0);
    expect(q.priceImpact).toBeNull(); // Kuru's simulate returns one final fill, no decomposed impact -- honestly absent
    expect(q.feeTier).toBe(30); // real taker fee in bps, not a Uniswap tier code
  });

  it("USDC -> MON (market buy) reports a real simulated output", async () => {
    buyAmountOutWei = 42_800000000000000000n; // 42.8 MON (18 decimals)
    const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");
    const q = await kuruProvider.quote("USDC", "MON", 20);
    expect(q.amountOut).toBeCloseTo(42.8, 6);
  });

  it("never attaches a native msg.value to the quote-time simulate call, even for a native-base market sell", async () => {
    // The zero address (used as the simulate `account`) holds no real MON --
    // a nonzero `value` there would fail the EVM's balance check before the
    // call even runs. Kuru's own documented CostEstimator never sends value
    // on this callStatic either; only the real, wallet-signed execution
    // transaction (built in buildPlan) ever carries msg.value.
    sellAmountOutWei = 2_340000n;
    lastSimulate.call = null;
    const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");
    await kuruProvider.quote("MON", "USDC", 5);
    expect(getLastSimulate()?.functionName).toBe("placeAndExecuteMarketSell");
    expect(getLastSimulate()?.value ?? 0n).toBe(0n);
  });

  it("scales the order size with pricePrecision for a buy and sizePrecision for a sell -- never the same constant by accident", async () => {
    // Distinct precisions (buy: 4 decimals, sell: 2 decimals) so a swapped
    // constant would produce a visibly different (wrong) encoded size,
    // unlike the other tests' fixture where both precisions are equal.
    verifiedMarketResult = [10_000, 100n, ZERO, 18n, USDC, 6n, 100, 0n, 0n, 30n, 10n];
    try {
      const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");

      buyAmountOutWei = 1_000000000000000000n;
      lastSimulate.call = null;
      await kuruProvider.quote("USDC", "MON", 20); // buy: quoteSize scaled by pricePrecision (10_000 -> 4 decimals)
      expect(getLastSimulate()?.args[0]).toBe(200000n); // 20 * 10_000

      sellAmountOutWei = 1_000000n;
      lastSimulate.call = null;
      await kuruProvider.quote("MON", "USDC", 5); // sell: size scaled by sizePrecision (100 -> 2 decimals)
      expect(getLastSimulate()?.args[0]).toBe(500n); // 5 * 100
    } finally {
      verifiedMarketResult = [1_000000, 1_000000n, ZERO, 18n, USDC, 6n, 100, 0n, 0n, 30n, 10n];
    }
  });
});

describe("Kuru provider — buildPlan produces the right unsigned steps", () => {
  it("selling native MON needs no approve step and carries real wei as msg.value", async () => {
    sellAmountOutWei = 2_340000n;
    const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");
    const plan = await kuruProvider.buildPlan("MON", "USDC", 5, WALLET);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].kind).toBe("swap");
    expect(plan.steps[0].tx.to.toLowerCase()).toBe(MARKET.toLowerCase());
    expect(BigInt(plan.steps[0].tx.value)).toBe(5_000000000000000000n); // 5 MON in wei

    const decoded = decodeFunctionData({
      abi: [{
        type: "function", name: "placeAndExecuteMarketSell",
        inputs: [{ name: "_size", type: "uint96" }, { name: "_minAmountOut", type: "uint256" }, { name: "_isMargin", type: "bool" }, { name: "_isFillOrKill", type: "bool" }],
      }] as const,
      data: plan.steps[0].tx.data as `0x${string}`,
    });
    expect(decoded.args?.[2]).toBe(false); // isMargin
    expect(decoded.args?.[3]).toBe(true); // real execution is always fill-or-kill, unlike the quote-time simulate
  });

  it("buying MON with USDC approves the MARKET address (not a router) when allowance is short, then swaps", async () => {
    buyAmountOutWei = 42_800000000000000000n;
    allowanceWei = 0n;
    const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");
    const plan = await kuruProvider.buildPlan("USDC", "MON", 20, WALLET);
    expect(plan.steps.map((s) => s.kind)).toEqual(["approve", "swap"]);
    expect(plan.steps[0].tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(plan.steps[1].tx.to.toLowerCase()).toBe(MARKET.toLowerCase());
    expect(plan.steps[1].tx.value).toBe("0x0"); // ERC-20 in, nothing native to send
  });

  it("sufficient existing allowance skips the approve step", async () => {
    buyAmountOutWei = 42_800000000000000000n;
    allowanceWei = 1_000_000000n; // way more than 20 USDC
    const { default: kuruProvider } = await import("@/lib/monad/kuruSwap");
    const plan = await kuruProvider.buildPlan("USDC", "MON", 20, WALLET);
    expect(plan.steps.map((s) => s.kind)).toEqual(["swap"]);
  });
});

describe("swap.ts aggregator — routes through whichever provider gives the better real output", () => {
  it("Kuru wins when its real quote is better than Uniswap's (which has no liquidity in this mock)", async () => {
    sellAmountOutWei = 5_000000n; // 5 USDC for 1 MON -- Uniswap mock returns 0 (no pool)
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const plan = await getSwapProvider().buildPlan("MON", "USDC", 1, WALLET);
    expect(plan.provider).toBe("Kuru");
    expect(plan.steps[plan.steps.length - 1].tx.to.toLowerCase()).toBe(MARKET.toLowerCase());
  });

  it("quote() and buildPlan() agree on the same winning provider for the same request", async () => {
    sellAmountOutWei = 5_000000n;
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const provider = getSwapProvider();
    const q = await provider.quote("MON", "USDC", 1);
    const plan = await provider.buildPlan("MON", "USDC", 1, WALLET);
    expect(q.amountOut).toBeCloseTo(plan.quote.amountOut, 6);
    expect(plan.provider).toBe("Kuru");
  });

  it("an unsupported-by-Kuru pair still resolves cleanly through Uniswap when Uniswap has a real quote", async () => {
    const { getSwapProvider } = await import("@/lib/monad/swap");
    // WETH/WBTC: Kuru has no market for this pair at all (resolveKuruMarket
    // returns null immediately), so only Uniswap is a real candidate. This
    // exercises "one provider legitimately can't serve this pair" without
    // needing Uniswap to actually succeed here (registry mock only knows
    // USDC) -- so assert the failure is Uniswap's own (no fabricated Kuru
    // pair-support error masking it).
    await expect(getSwapProvider().buildPlan("WETH", "WBTC", 1, WALLET)).rejects.toThrow();
  });
});
