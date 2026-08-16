import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData } from "viem";

/* The swap engine's only external inputs are the chain (quoter simulateContract
   / allowance readContract) and the token registry. Stub both so the tests
   exercise the real quoting/plan-building logic:
     - a dust-sized quote never signs a transaction with amountOutMinimum = 0
       (Ultrafuzz L-04)
     - slippage tolerance is bounded, and buildPlan's own slippage argument
       is actually honored end to end, not silently ignored
     - a trade whose own size would move the pool price too much (estimated
       via a smaller reference quote at the same fee tier) is refused rather
       than signed into blindly

   quoteFn(amountInWei) computes the mocked quoter's amountOut for whatever
   amountIn it's called with, so each test can express EITHER a perfectly
   linear/no-impact pool (the common case, used to isolate slippage/minOut
   behavior) OR a specific non-linear shortfall to exercise the price-impact
   check. 1 MON in == 1_000000000000000000n wei; the price-impact reference
   quote always asks for exactly 1/1000th of that. */

let quoteFn: (amountInWei: bigint) => bigint = () => 0n;

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    simulateContract: async ({ functionName, args }: { functionName: string; args: [{ amountIn: bigint }] }) => {
      if (functionName === "quoteExactInputSingle") {
        return { result: [quoteFn(args[0].amountIn), 0n, 0, 0n] };
      }
      throw new Error(`unexpected simulateContract call: ${functionName}`);
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return 0n;
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
  }),
}));

vi.mock("@/lib/monad/config", () => ({
  getNetwork: () => "mainnet",
  getStablecoin: () => ({ address: "0x1234567890123456789012345678901234567890", decimals: 6 }),
}));

let getVerifiedTokensCalls = 0;
vi.mock("@/lib/monad/tokenRegistry", () => ({
  getVerifiedTokens: async () => {
    getVerifiedTokensCalls += 1;
    return [
      { address: "0x1234567890123456789012345678901234567890", symbol: "USDC", name: "USD Coin", decimals: 6, verified: true },
      { address: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d", symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true },
    ];
  },
}));

const EXACT_INPUT_SINGLE_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
const ONE_MON_WEI = 1_000000000000000000n;

/** A perfectly linear (zero price-impact) pool at the given rate: `rateNum`
 *  USDC base units out per 1e18 wei of MON in. */
function linearPool(rateNum: bigint) {
  return (amountInWei: bigint) => (amountInWei * rateNum) / ONE_MON_WEI;
}

describe("swap.buildPlan — amountOutMinimum is never 0 for a positive quote", () => {
  it("bumps a dust quote's amountOutMinimum to 1 instead of flooring to 0 in the ACTUAL signed calldata", async () => {
    // 1 wei out for the full trade; the price-impact reference quote (1/1000th
    // the size) naturally floors to 0 at this rate, so impact is un-estimable
    // (null) rather than falsely rejected.
    quoteFn = linearPool(1n);
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const plan = await getSwapProvider().buildPlan("MON", "USDC", 1, WALLET);

    expect(plan.quote.minAmountOut).toBeGreaterThan(0);
    expect(plan.quote.priceImpact).toBeNull();

    const swapStep = plan.steps.find((s) => s.kind === "swap")!;
    const decoded = decodeFunctionData({ abi: EXACT_INPUT_SINGLE_ABI, data: swapStep.tx.data });
    const params = decoded.args[0];
    expect(params.amountOutMinimum).toBe(1n); // NOT 0n
  });

  it("still computes a normal ~0.5% slippage floor for a non-dust, no-impact quote", async () => {
    quoteFn = linearPool(100_000000n); // 100 USDC per 1 MON, perfectly linear
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const plan = await getSwapProvider().buildPlan("MON", "USDC", 1, WALLET);

    expect(plan.quote.priceImpact).toBe(0);
    const swapStep = plan.steps.find((s) => s.kind === "swap")!;
    const decoded = decodeFunctionData({ abi: EXACT_INPUT_SINGLE_ABI, data: swapStep.tx.data });
    const params = decoded.args[0];
    // 100 USDC * 0.995 = 99.5 USDC = 99_500000n, well clear of the dust bump.
    expect(params.amountOutMinimum).toBe(99_500000n);
  });

  it("honors a custom slippage passed to buildPlan, not just quote()'s hardcoded default", async () => {
    quoteFn = linearPool(100_000000n);
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const plan = await getSwapProvider().buildPlan("MON", "USDC", 1, WALLET, 0.10); // 10% slippage

    expect(plan.quote.slippage).toBe(0.10);
    const swapStep = plan.steps.find((s) => s.kind === "swap")!;
    const decoded = decodeFunctionData({ abi: EXACT_INPUT_SINGLE_ABI, data: swapStep.tx.data });
    const params = decoded.args[0];
    expect(params.amountOutMinimum).toBe(90_000000n); // 100 * 0.90
  });

  it("quote() also reports a positive minAmountOut for a dust-sized output", async () => {
    quoteFn = linearPool(1n);
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const q = await getSwapProvider().quote("MON", "USDC", 1);
    expect(q.minAmountOut).toBeGreaterThan(0);
  });
});

describe("swap — slippage tolerance is bounded", () => {
  it("rejects a slippage above the hard ceiling instead of signing an effectively unprotected trade", async () => {
    quoteFn = linearPool(100_000000n);
    const { getSwapProvider, MAX_SLIPPAGE } = await import("@/lib/monad/swap");
    await expect(getSwapProvider().buildPlan("MON", "USDC", 1, WALLET, 0.9)).rejects.toThrow(/slippage/i);
    expect(MAX_SLIPPAGE).toBeLessThan(0.9);
  });

  it("rejects a negative slippage", async () => {
    quoteFn = linearPool(100_000000n);
    const { getSwapProvider } = await import("@/lib/monad/swap");
    await expect(getSwapProvider().buildPlan("MON", "USDC", 1, WALLET, -0.01)).rejects.toThrow(/slippage/i);
  });

  it("accepts slippage exactly at the ceiling", async () => {
    quoteFn = linearPool(100_000000n);
    const { getSwapProvider, MAX_SLIPPAGE } = await import("@/lib/monad/swap");
    await expect(getSwapProvider().buildPlan("MON", "USDC", 1, WALLET, MAX_SLIPPAGE)).resolves.toBeDefined();
  });
});

describe("swap — price-impact (bad quote) protection", () => {
  it("refuses to build a plan when the trade's own size would move the price beyond the ceiling", async () => {
    // The full-size trade gets a badly under-priced fill (50 USDC) while a
    // 1/1000th-sized reference trade at the SAME fee tier gets the fair
    // linear rate (100 USDC per MON) -- a ~50% price-impact shortfall.
    const referenceRate = linearPool(100_000000n);
    quoteFn = (amountInWei) => (amountInWei === ONE_MON_WEI ? 50_000000n : referenceRate(amountInWei));

    const { getSwapProvider } = await import("@/lib/monad/swap");
    await expect(getSwapProvider().buildPlan("MON", "USDC", 1, WALLET)).rejects.toThrow(/price/i);
  });

  it("reports a nonzero but under-threshold price impact on the quote without rejecting it", async () => {
    // Full trade returns 95 vs. a fair 100 -- a 5% shortfall, well under the
    // 15% ceiling, so this must be allowed through and the figure exposed.
    const referenceRate = linearPool(100_000000n);
    quoteFn = (amountInWei) => (amountInWei === ONE_MON_WEI ? 95_000000n : referenceRate(amountInWei));

    const { getSwapProvider } = await import("@/lib/monad/swap");
    const q = await getSwapProvider().quote("MON", "USDC", 1);
    expect(q.priceImpact).toBeGreaterThan(0.04);
    expect(q.priceImpact).toBeLessThan(0.06);
  });
});

describe("quoteUniswapDirect — the general address-based probe reused by tokenIntelligence.ts and tradeQuote.ts", () => {
  const TOKEN_IN = "0xaaaabbbbccccddddeeeeffff0000111122223333" as const;
  const TOKEN_OUT = "0xffffeeeeddddccccbbbbaaaa0000111122223333" as const;

  it("quotes a real pool and reports price impact, exactly for the requested amount", async () => {
    quoteFn = linearPool(100_000000n); // 100 USDC-ish base units per 1e18 wei in, no impact
    const { quoteUniswapDirect } = await import("@/lib/monad/swap");
    const r = await quoteUniswapDirect(TOKEN_IN, 18, TOKEN_OUT, 6, "2");
    expect(r).not.toBeNull();
    expect(Number(r!.amountOut)).toBeCloseTo(200, 5);
  });

  it("returns null (never a fabricated output) when every fee tier reverts", async () => {
    quoteFn = () => 0n;
    const { quoteUniswapDirect } = await import("@/lib/monad/swap");
    const r = await quoteUniswapDirect(TOKEN_IN, 18, TOKEN_OUT, 6, "1");
    expect(r).toBeNull();
  });

  it("reports a real price-impact percentage when the trade's own size moves the pool", async () => {
    const referenceRate = linearPool(100_000000n);
    quoteFn = (amountInWei) => (amountInWei === ONE_MON_WEI ? 90_000000n : referenceRate(amountInWei)); // 10% shortfall
    const { quoteUniswapDirect } = await import("@/lib/monad/swap");
    const r = await quoteUniswapDirect(TOKEN_IN, 18, TOKEN_OUT, 6, "1");
    expect(r).not.toBeNull();
    expect(r!.priceImpact).not.toBeNull();
    const impactPct = parseFloat(r!.priceImpact!);
    expect(impactPct).toBeGreaterThan(8);
    expect(impactPct).toBeLessThan(12);
  });
});

describe("resolveSwapSide — USDC (like MON) resolves without the full curated-registry fan-out", () => {
  it("MON never calls getVerifiedTokens (existing behavior, unchanged)", async () => {
    getVerifiedTokensCalls = 0;
    const { resolveSwapSide } = await import("@/lib/monad/swap");
    const side = await resolveSwapSide("mon");
    expect(side.isNative).toBe(true);
    expect(getVerifiedTokensCalls).toBe(0);
  });

  it("USDC resolves straight from getStablecoin() -- zero calls to getVerifiedTokens, the RPC-heavy full curated-list fan-out", async () => {
    getVerifiedTokensCalls = 0;
    const { resolveSwapSide } = await import("@/lib/monad/swap");
    const side = await resolveSwapSide("usdc");
    expect(side).toEqual({ symbol: "USDC", routeAddress: "0x1234567890123456789012345678901234567890", decimals: 6, isNative: false });
    expect(getVerifiedTokensCalls).toBe(0);
  });

  it("a non-special-cased curated symbol (e.g. USDT0) still resolves via the registry, unaffected", async () => {
    getVerifiedTokensCalls = 0;
    const { resolveSwapSide } = await import("@/lib/monad/swap");
    const side = await resolveSwapSide("usdt0");
    expect(side.routeAddress.toLowerCase()).toBe("0xe7cd86e13ac4309349f30b3435a9d337750fc82d");
    expect(getVerifiedTokensCalls).toBe(1);
  });

  it("an unrecognized symbol is still rejected honestly, not silently defaulted", async () => {
    getVerifiedTokensCalls = 0;
    const { resolveSwapSide } = await import("@/lib/monad/swap");
    await expect(resolveSwapSide("NOTATHING")).rejects.toThrow(/isn't a token PayAI can swap yet/i);
  });
});
