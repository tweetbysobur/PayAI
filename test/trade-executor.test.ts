import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, parseUnits } from "viem";

/**
 * lib/monad/tradeExecutor.ts — the PayAITradeExecutor plan builder + event
 * decoder (Gate 5). Its only external inputs are the config flag/addresses, the
 * public client (allowance/feeBps/allowlist reads), swap.ts's Uniswap quote
 * primitives, and kuruSwap.ts's quoteKuruForExecutor — all stubbed here so the
 * tests exercise the real fee math, calldata construction, and event decoding
 * without a real RPC or DEX. On-chain correctness of the produced calldata was
 * separately proven by the Gate 4 mainnet canaries.
 */

const EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const ZERO = "0x0000000000000000000000000000000000000000";

let executorAddr: string | null = EXECUTOR;
vi.mock("@/lib/monad/config", () => ({
  getPayAITradeExecutor: () => executorAddr,
  getWrappedNative: () => WMON,
}));

let allowanceImpl = async () => 0n;
let feeBpsImpl = async () => 25;
let allowedImpl = async () => true;
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return allowanceImpl();
      if (functionName === "feeBps") return feeBpsImpl();
      if (functionName === "allowedKuruMarket") return allowedImpl();
      throw new Error(`unexpected readContract ${functionName}`);
    },
  }),
}));

let bestTierImpl: (tokenIn: string, tokenOut: string, amountIn: bigint) => Promise<{ fee: number; amountOut: bigint } | null> =
  async () => ({ fee: 3000, amountOut: 200n });
vi.mock("@/lib/monad/swap", () => ({
  quoteBestUniswapTier: (tokenIn: string, tokenOut: string, amountIn: bigint) => bestTierImpl(tokenIn, tokenOut, amountIn),
  minOutWei: (out: bigint, slippage: number) => (out * BigInt(Math.round((1 - slippage) * 1e6))) / 1_000_000n,
  estimatePriceImpact: async () => null,
  ERC20_ABI: [
    { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  ],
}));

let kuruQuoteImpl: (...a: unknown[]) => Promise<unknown> = async () => ({
  marketAddress: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394", isBuy: false,
  debitAddress: ZERO, debitDecimals: 18, debitIsNative: true,
  outAddress: USDC, outDecimals: 6, outIsNative: false,
  kuruSize: 199500000n, minOutWei: 500000n, expectedOutWei: 510000n,
});
vi.mock("@/lib/monad/kuruSwap", () => ({ quoteKuruForExecutor: (...a: unknown[]) => kuruQuoteImpl(...a) }));

vi.mock("@/lib/monad/verify", () => ({ normalizeDecimalString: (s: string) => s }));

afterEach(() => {
  vi.restoreAllMocks();
  executorAddr = EXECUTOR;
  allowanceImpl = async () => 0n;
  feeBpsImpl = async () => 25;
  allowedImpl = async () => true;
  bestTierImpl = async () => ({ fee: 3000, amountOut: 200n });
  kuruQuoteImpl = async () => ({
    marketAddress: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394", isBuy: false,
    debitAddress: ZERO, debitDecimals: 18, debitIsNative: true,
    outAddress: USDC, outDecimals: 6, outIsNative: false,
    kuruSize: 199500000n, minOutWei: 500000n, expectedOutWei: 510000n,
  });
});

describe("applyExecutorFee", () => {
  it("takes floor(gross * feeBps / 10000) as the fee, never over-charging", async () => {
    const { applyExecutorFee } = await import("@/lib/monad/tradeExecutor");
    expect(applyExecutorFee(100_000000n, 25)).toEqual({ feeWei: 250000n, netWei: 99_750000n }); // 100 USDC → 0.00005*... = 0.25 USDC fee? (25bps of 100e6)
    // 100e6 * 25 / 10000 = 250000 (0.25 USDC). net = 99.75 USDC.
    expect(applyExecutorFee(3n, 25)).toEqual({ feeWei: 0n, netWei: 3n }); // dust floors to zero fee
    expect(applyExecutorFee(0n, 25)).toEqual({ feeWei: 0n, netWei: 0n });
  });
});

describe("buildUniswapExecutorPlan", () => {
  it("ERC-20 in: approves the EXECUTOR (not the router) for the GROSS, and the swap calls tradeUniswapExactInput on the executor", async () => {
    const { buildUniswapExecutorPlan, TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildUniswapExecutorPlan(USDC, "USDC", 6, false, WMON, "WMON", 18, false, "100", 0.01, WALLET);
    expect(plan.feeBps).toBe(25);
    expect(plan.feeAmount).toBe("0.25");           // 100 * 0.25%
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].kind).toBe("approve");
    expect(plan.steps[0].tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    const swap = plan.steps[1];
    expect(swap.kind).toBe("swap");
    expect(swap.tx.to.toLowerCase()).toBe(EXECUTOR.toLowerCase());   // targets the executor
    expect(swap.tx.value).toBe("0x0");                                // ERC-20 in: no native value
    const decoded = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: swap.tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("tradeUniswapExactInput");
    // grossAmountIn is the GROSS (executor takes the fee internally, swaps the net)
    expect(decoded.args[3]).toBe(parseUnits("100", 6));
  });

  it("native MON in: no approve step, attaches the gross as msg.value, and passes address(0) as tokenIn", async () => {
    const { buildUniswapExecutorPlan, TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildUniswapExecutorPlan(WMON, "MON", 18, true, USDC, "USDC", 6, false, "1", 0.01, WALLET);
    expect(plan.steps).toHaveLength(1);            // native input needs no approval
    const swap = plan.steps[0];
    expect(swap.tx.to.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(BigInt(swap.tx.value)).toBe(parseUnits("1", 18));   // gross attached as value
    const decoded = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: swap.tx.data as `0x${string}` });
    expect((decoded.args[0] as string).toLowerCase()).toBe(ZERO);   // tokenIn == address(0)
  });

  it("skips the approve when the wallet already granted enough allowance to the executor", async () => {
    allowanceImpl = async () => parseUnits("1000", 6);
    const { buildUniswapExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildUniswapExecutorPlan(USDC, "USDC", 6, false, WMON, "WMON", 18, false, "100", 0.01, WALLET);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("swap");
  });
});

describe("buildKuruExecutorPlan", () => {
  it("allowlisted market: builds an executor tradeKuruExactInput (native in → attaches value)", async () => {
    const { buildKuruExecutorPlan, TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildKuruExecutorPlan("MON", "USDC", 18, "1", 0.02, WALLET);
    expect(plan).not.toBeNull();
    const swap = plan!.steps[plan!.steps.length - 1];
    expect(swap.tx.to.toLowerCase()).toBe(EXECUTOR.toLowerCase());
    expect(BigInt(swap.tx.value)).toBe(parseUnits("1", 18));
    const decoded = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: swap.tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("tradeKuruExactInput");
    expect(decoded.args[5]).toBe(parseUnits("1", 18)); // grossAmountIn
  });

  it("market NOT on the executor allowlist: returns null so the caller falls back to the direct path", async () => {
    allowedImpl = async () => false;
    const { buildKuruExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildKuruExecutorPlan("MON", "USDC", 18, "1", 0.02, WALLET);
    expect(plan).toBeNull();
  });

  it("pair Kuru doesn't serve: returns null (direct fallback)", async () => {
    kuruQuoteImpl = async () => null;
    const { buildKuruExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    expect(await buildKuruExecutorPlan("MON", "USDC", 18, "1", 0.02, WALLET)).toBeNull();
  });
});

describe("decodeTradeExecuted", () => {
  const EVENT_ABI = [{
    type: "event", name: "TradeExecuted",
    inputs: [
      { name: "tradeId", type: "uint256", indexed: true }, { name: "user", type: "address", indexed: true },
      { name: "venue", type: "uint8", indexed: false }, { name: "tokenIn", type: "address", indexed: false }, { name: "tokenOut", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false }, { name: "amountOut", type: "uint256", indexed: false }, { name: "feeAmount", type: "uint256", indexed: false },
    ],
  }] as const;

  function tradeLog(address: string) {
    const topics = encodeEventTopics({ abi: EVENT_ABI, eventName: "TradeExecuted", args: { tradeId: 4n, user: WALLET as `0x${string}` } });
    const data = encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [1, ZERO as `0x${string}`, USDC as `0x${string}`, parseUnits("1", 18), 599n, parseUnits("0.00005", 18)],
    );
    return { address, data, topics } as unknown as import("viem").Log;
  }

  it("decodes the executor's TradeExecuted from the receipt logs", async () => {
    const { decodeTradeExecuted } = await import("@/lib/monad/tradeExecutor");
    const ev = decodeTradeExecuted([tradeLog(EXECUTOR)]);
    expect(ev).not.toBeNull();
    expect(ev!.venue).toBe(1);
    expect(ev!.user.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(ev!.tokenOut.toLowerCase()).toBe(USDC.toLowerCase());
    expect(ev!.amountOut).toBe(599n);
    expect(ev!.feeAmount).toBe(parseUnits("0.00005", 18));
  });

  it("ignores a TradeExecuted-shaped log emitted by a DIFFERENT address (not our executor)", async () => {
    const { decodeTradeExecuted } = await import("@/lib/monad/tradeExecutor");
    expect(decodeTradeExecuted([tradeLog("0x000000000000000000000000000000000000dEaD")])).toBeNull();
  });

  it("returns null when no executor is configured", async () => {
    executorAddr = null;
    const { decodeTradeExecuted } = await import("@/lib/monad/tradeExecutor");
    expect(decodeTradeExecuted([tradeLog(EXECUTOR)])).toBeNull();
  });
});
