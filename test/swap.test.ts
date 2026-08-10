import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData } from "viem";

/* The swap engine's only external inputs are the chain (quoter simulateContract
   / allowance readContract) and the token registry. Stub both so the tests
   exercise the real quoting/plan-building logic — in particular, that a
   dust-sized quote never signs a transaction with amountOutMinimum = 0
   (Ultrafuzz L-04). */

let quoterAmountOut = 0n;

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    simulateContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "quoteExactInputSingle") {
        return { result: [quoterAmountOut, 0n, 0, 0n] };
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

vi.mock("@/lib/monad/tokenRegistry", () => ({
  getVerifiedTokens: async () => [
    { address: "0x1234567890123456789012345678901234567890", symbol: "USDC", name: "USD Coin", decimals: 6, verified: true },
  ],
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

describe("swap.buildPlan — amountOutMinimum is never 0 for a positive quote", () => {
  it("bumps a dust quote's amountOutMinimum to 1 instead of flooring to 0 in the ACTUAL signed calldata", async () => {
    quoterAmountOut = 1n; // smallest possible output unit
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const plan = await getSwapProvider().buildPlan("MON", "USDC", 1, WALLET);

    expect(plan.quote.minAmountOut).toBeGreaterThan(0);

    const swapStep = plan.steps.find((s) => s.kind === "swap")!;
    const decoded = decodeFunctionData({ abi: EXACT_INPUT_SINGLE_ABI, data: swapStep.tx.data });
    const params = decoded.args[0];
    expect(params.amountOutMinimum).toBe(1n); // NOT 0n
  });

  it("still computes a normal ~0.5% slippage floor for a non-dust quote", async () => {
    quoterAmountOut = 100_000000n; // 100 USDC (6dp)
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const plan = await getSwapProvider().buildPlan("MON", "USDC", 1, WALLET);

    const swapStep = plan.steps.find((s) => s.kind === "swap")!;
    const decoded = decodeFunctionData({ abi: EXACT_INPUT_SINGLE_ABI, data: swapStep.tx.data });
    const params = decoded.args[0];
    // 100 USDC * 0.995 = 99.5 USDC = 99_500000n, well clear of the dust bump.
    expect(params.amountOutMinimum).toBe(99_500000n);
  });

  it("honors a custom slippage passed to buildPlan, not just quote()'s hardcoded default", async () => {
    quoterAmountOut = 100_000000n;
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const plan = await getSwapProvider().buildPlan("MON", "USDC", 1, WALLET, 0.10); // 10% slippage

    expect(plan.quote.slippage).toBe(0.10);
    const swapStep = plan.steps.find((s) => s.kind === "swap")!;
    const decoded = decodeFunctionData({ abi: EXACT_INPUT_SINGLE_ABI, data: swapStep.tx.data });
    const params = decoded.args[0];
    expect(params.amountOutMinimum).toBe(90_000000n); // 100 * 0.90
  });

  it("quote() also reports a positive minAmountOut for a dust-sized output", async () => {
    quoterAmountOut = 1n;
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const q = await getSwapProvider().quote("MON", "USDC", 1);
    expect(q.minAmountOut).toBeGreaterThan(0);
  });
});
