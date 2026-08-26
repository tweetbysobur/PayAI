import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, parseUnits } from "viem";

/**
 * lib/monad/tradeExecutor.ts — the PayAITradeExecutor plan builder + event
 * decoder (Gate 5 Uniswap/Kuru, Gate 7 + Nad.Fun via V2). Its only external
 * inputs are the config flags/addresses, the public client (allowance/feeBps/
 * allowlist reads), swap.ts's Uniswap quote primitives, kuruSwap.ts's
 * quoteKuruForExecutor, and nadfun.ts's nadFunQuote — all stubbed here so the
 * tests exercise the real fee math, calldata construction, venue selection,
 * and event decoding without a real RPC or DEX. On-chain correctness of the
 * produced calldata was separately proven by the Gate 4 mainnet canaries
 * (Uniswap/Kuru) and the Gate 7 Hardhat suite (Nad.Fun, PayAITradeExecutorV2).
 */

const V1 = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const V2_ADDR = "0x2222222222222222222222222222222222222222";
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const NADTOKEN = "0x9999999999999999999999999999999999999999";
const NADROUTER = "0x8888888888888888888888888888888888888888";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const ZERO = "0x0000000000000000000000000000000000000000";

let v1Addr: string | null = V1;
let v2Addr: string | null = null;
let v1Enabled = true;
let v2Enabled = false;
vi.mock("@/lib/monad/config", () => ({
  getPayAITradeExecutor: () => v1Addr,
  getPayAITradeExecutorV2: () => v2Addr,
  tradeExecutorEnabled: () => v1Addr !== null && v1Enabled,
  tradeExecutorV2Enabled: () => v2Addr !== null && v2Enabled,
  getWrappedNative: () => WMON,
}));

let allowanceImpl = async () => 0n;
let feeBpsImpl = async () => 25;
let allowedKuruImpl = async () => true;
let allowedNadFunImpl = async () => true;
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "allowance") return allowanceImpl();
      if (functionName === "feeBps") return feeBpsImpl();
      if (functionName === "allowedKuruMarket") return allowedKuruImpl();
      if (functionName === "allowedNadFunRouter") return allowedNadFunImpl();
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

let nadFunQuoteImpl: (token: string, decimals: number, amountIn: string, isBuy: boolean) => Promise<{ provider: "Nad.Fun"; router: string; amountOut: string; isBuy: boolean } | null> =
  async (_t, _d, amountIn, isBuy) => ({ provider: "Nad.Fun", router: NADROUTER, amountOut: isBuy ? "500" : "0.02", isBuy });
vi.mock("@/lib/monad/nadfun", () => ({ nadFunQuote: (t: string, d: number, a: string, b: boolean) => nadFunQuoteImpl(t, d, a, b) }));

vi.mock("@/lib/monad/verify", () => ({ normalizeDecimalString: (s: string) => s }));

afterEach(() => {
  vi.restoreAllMocks();
  v1Addr = V1; v2Addr = null; v1Enabled = true; v2Enabled = false;
  allowanceImpl = async () => 0n;
  feeBpsImpl = async () => 25;
  allowedKuruImpl = async () => true;
  allowedNadFunImpl = async () => true;
  bestTierImpl = async () => ({ fee: 3000, amountOut: 200n });
  kuruQuoteImpl = async () => ({
    marketAddress: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394", isBuy: false,
    debitAddress: ZERO, debitDecimals: 18, debitIsNative: true,
    outAddress: USDC, outDecimals: 6, outIsNative: false,
    kuruSize: 199500000n, minOutWei: 500000n, expectedOutWei: 510000n,
  });
  nadFunQuoteImpl = async (_t, _d, amountIn, isBuy) => ({ provider: "Nad.Fun", router: NADROUTER, amountOut: isBuy ? "500" : "0.02", isBuy });
});

describe("selectExecutor (Gate 7 dispatch)", () => {
  it("flag off everywhere: no executor for any venue", async () => {
    v1Enabled = false;
    const { selectExecutor } = await import("@/lib/monad/tradeExecutor");
    expect(selectExecutor("uniswap")).toBeNull();
    expect(selectExecutor("kuru")).toBeNull();
    expect(selectExecutor("nadfun")).toBeNull();
  });

  it("V1 only enabled: serves Uniswap/Kuru, never Nad.Fun", async () => {
    const { selectExecutor } = await import("@/lib/monad/tradeExecutor");
    expect(selectExecutor("uniswap")).toBe(V1);
    expect(selectExecutor("kuru")).toBe(V1);
    expect(selectExecutor("nadfun")).toBeNull();
  });

  it("V2 enabled: serves all three venues, superseding V1", async () => {
    v2Addr = V2_ADDR; v2Enabled = true;
    const { selectExecutor } = await import("@/lib/monad/tradeExecutor");
    expect(selectExecutor("uniswap")).toBe(V2_ADDR);
    expect(selectExecutor("kuru")).toBe(V2_ADDR);
    expect(selectExecutor("nadfun")).toBe(V2_ADDR);
  });

  it("V2 configured but not enabled: falls back to V1 behavior exactly", async () => {
    v2Addr = V2_ADDR; v2Enabled = false;
    const { selectExecutor } = await import("@/lib/monad/tradeExecutor");
    expect(selectExecutor("uniswap")).toBe(V1);
    expect(selectExecutor("nadfun")).toBeNull();
  });
});

describe("applyExecutorFee", () => {
  it("takes floor(gross * feeBps / 10000) as the fee, never over-charging", async () => {
    const { applyExecutorFee } = await import("@/lib/monad/tradeExecutor");
    expect(applyExecutorFee(100_000000n, 25)).toEqual({ feeWei: 250000n, netWei: 99_750000n });
    expect(applyExecutorFee(3n, 25)).toEqual({ feeWei: 0n, netWei: 3n }); // dust floors to zero fee
    expect(applyExecutorFee(0n, 25)).toEqual({ feeWei: 0n, netWei: 0n });
  });
});

describe("buildUniswapExecutorPlan", () => {
  it("ERC-20 in: approves the given executor (not the router) for the GROSS, and the swap targets it", async () => {
    const { buildUniswapExecutorPlan, TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildUniswapExecutorPlan(V1 as `0x${string}`, USDC, "USDC", 6, false, WMON, "WMON", 18, false, "100", 0.01, WALLET);
    expect(plan.feeBps).toBe(25);
    expect(plan.feeAmount).toBe("0.25");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].kind).toBe("approve");
    expect(plan.steps[0].tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    const swap = plan.steps[1];
    expect(swap.kind).toBe("swap");
    expect(swap.tx.to.toLowerCase()).toBe(V1.toLowerCase());
    expect(swap.tx.value).toBe("0x0");
    const decoded = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: swap.tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("tradeUniswapExactInput");
    expect(decoded.args[3]).toBe(parseUnits("100", 6));
  });

  it("native MON in: no approve step, attaches the gross as msg.value, and passes address(0) as tokenIn", async () => {
    const { buildUniswapExecutorPlan, TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildUniswapExecutorPlan(V1 as `0x${string}`, WMON, "MON", 18, true, USDC, "USDC", 6, false, "1", 0.01, WALLET);
    expect(plan.steps).toHaveLength(1);
    const swap = plan.steps[0];
    expect(BigInt(swap.tx.value)).toBe(parseUnits("1", 18));
    const decoded = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: swap.tx.data as `0x${string}` });
    expect((decoded.args[0] as string).toLowerCase()).toBe(ZERO);
  });

  it("skips the approve when the wallet already granted enough allowance to the given executor", async () => {
    allowanceImpl = async () => parseUnits("1000", 6);
    const { buildUniswapExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildUniswapExecutorPlan(V1 as `0x${string}`, USDC, "USDC", 6, false, WMON, "WMON", 18, false, "100", 0.01, WALLET);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("swap");
  });

  it("targets whichever executor address is passed (V2)", async () => {
    const { buildUniswapExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildUniswapExecutorPlan(V2_ADDR as `0x${string}`, USDC, "USDC", 6, false, WMON, "WMON", 18, false, "100", 0.01, WALLET);
    expect(plan.steps[plan.steps.length - 1].tx.to.toLowerCase()).toBe(V2_ADDR.toLowerCase());
  });
});

describe("buildKuruExecutorPlan", () => {
  it("allowlisted market: builds an executor tradeKuruExactInput (native in → attaches value)", async () => {
    const { buildKuruExecutorPlan, TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildKuruExecutorPlan(V1 as `0x${string}`, "MON", "USDC", 18, "1", 0.02, WALLET);
    expect(plan).not.toBeNull();
    const swap = plan!.steps[plan!.steps.length - 1];
    expect(swap.tx.to.toLowerCase()).toBe(V1.toLowerCase());
    expect(BigInt(swap.tx.value)).toBe(parseUnits("1", 18));
    const decoded = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: swap.tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("tradeKuruExactInput");
    expect(decoded.args[5]).toBe(parseUnits("1", 18));
  });

  it("market NOT on the given executor's allowlist: returns null so the caller falls back to the direct path", async () => {
    allowedKuruImpl = async () => false;
    const { buildKuruExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildKuruExecutorPlan(V1 as `0x${string}`, "MON", "USDC", 18, "1", 0.02, WALLET);
    expect(plan).toBeNull();
  });

  it("pair Kuru doesn't serve: returns null (direct fallback)", async () => {
    kuruQuoteImpl = async () => null;
    const { buildKuruExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    expect(await buildKuruExecutorPlan(V1 as `0x${string}`, "MON", "USDC", 18, "1", 0.02, WALLET)).toBeNull();
  });
});

describe("buildNadFunExecutorPlan (Gate 7)", () => {
  it("BUY: native MON attached as value, router from the Lens quote, output token as the tuple's `token`", async () => {
    const { buildNadFunExecutorPlan, TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildNadFunExecutorPlan(V2_ADDR as `0x${string}`, NADTOKEN, "DEGEN", 18, true, "1", 0.02, WALLET);
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(1); // native in, no approval
    const swap = plan!.steps[0];
    expect(swap.tx.to.toLowerCase()).toBe(V2_ADDR.toLowerCase());
    expect(BigInt(swap.tx.value)).toBe(parseUnits("1", 18)); // gross MON attached
    const decoded = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: swap.tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("tradeNadFunExactInput");
    expect((decoded.args[0] as string).toLowerCase()).toBe(NADROUTER.toLowerCase()); // router from the Lens quote
    expect(decoded.args[1]).toBe(true); // isBuy
    expect((decoded.args[2] as string).toLowerCase()).toBe(NADTOKEN.toLowerCase());
    expect(decoded.args[3]).toBe(parseUnits("1", 18)); // grossAmountIn
  });

  it("SELL: approves the executor for the token GROSS, no native value attached", async () => {
    const { buildNadFunExecutorPlan, TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    const plan = await buildNadFunExecutorPlan(V2_ADDR as `0x${string}`, NADTOKEN, "DEGEN", 18, false, "10", 0.02, WALLET);
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(2); // approve + swap
    expect(plan!.steps[0].kind).toBe("approve");
    expect(plan!.steps[0].tx.to.toLowerCase()).toBe(NADTOKEN.toLowerCase());
    const swap = plan!.steps[1];
    expect(swap.tx.value).toBe("0x0");
    const decoded = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: swap.tx.data as `0x${string}` });
    expect(decoded.args[1]).toBe(false); // isBuy
    expect(decoded.args[3]).toBe(parseUnits("10", 18)); // grossAmountIn
  });

  it("Nad.Fun doesn't serve this token/direction: returns null (direct fallback)", async () => {
    nadFunQuoteImpl = async () => null;
    const { buildNadFunExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    expect(await buildNadFunExecutorPlan(V2_ADDR as `0x${string}`, NADTOKEN, "DEGEN", 18, true, "1", 0.02, WALLET)).toBeNull();
  });

  it("Lens names a router NOT on the executor's Nad.Fun allowlist: returns null (direct fallback), never trusts the Lens's pick", async () => {
    allowedNadFunImpl = async () => false;
    const { buildNadFunExecutorPlan } = await import("@/lib/monad/tradeExecutor");
    expect(await buildNadFunExecutorPlan(V2_ADDR as `0x${string}`, NADTOKEN, "DEGEN", 18, true, "1", 0.02, WALLET)).toBeNull();
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

  function tradeLog(address: string, venue = 1) {
    const topics = encodeEventTopics({ abi: EVENT_ABI, eventName: "TradeExecuted", args: { tradeId: 4n, user: WALLET as `0x${string}` } });
    const data = encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [venue, ZERO as `0x${string}`, USDC as `0x${string}`, parseUnits("1", 18), 599n, parseUnits("0.00005", 18)],
    );
    return { address, data, topics } as unknown as import("viem").Log;
  }

  it("decodes V1's TradeExecuted from the receipt logs", async () => {
    const { decodeTradeExecuted } = await import("@/lib/monad/tradeExecutor");
    const ev = decodeTradeExecuted([tradeLog(V1)]);
    expect(ev).not.toBeNull();
    expect(ev!.venue).toBe(1);
    expect(ev!.user.toLowerCase()).toBe(WALLET.toLowerCase());
    expect(ev!.amountOut).toBe(599n);
  });

  it("ALSO recognizes V2's emitter once V2 is configured — V1's existing behavior is not narrowed", async () => {
    v2Addr = V2_ADDR;
    const { decodeTradeExecuted } = await import("@/lib/monad/tradeExecutor");
    expect(decodeTradeExecuted([tradeLog(V1)])).not.toBeNull(); // V1 still recognized
    const ev2 = decodeTradeExecuted([tradeLog(V2_ADDR, 2)]);
    expect(ev2).not.toBeNull();
    expect(ev2!.venue).toBe(2); // VENUE_NADFUN
  });

  it("ignores a TradeExecuted-shaped log emitted by a DIFFERENT address (not either configured executor)", async () => {
    const { decodeTradeExecuted } = await import("@/lib/monad/tradeExecutor");
    expect(decodeTradeExecuted([tradeLog("0x000000000000000000000000000000000000dEaD")])).toBeNull();
  });

  it("returns null when no executor is configured", async () => {
    v1Addr = null;
    const { decodeTradeExecuted } = await import("@/lib/monad/tradeExecutor");
    expect(decodeTradeExecuted([tradeLog(V1)])).toBeNull();
  });
});
