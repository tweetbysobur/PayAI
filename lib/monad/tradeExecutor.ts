/**
 * PayAITradeExecutor integration — Gate 5.
 *
 * Builds the unsigned `approve` + `swap` steps for an INTERACTIVE, user-signed
 * trade that routes through the deployed, Safe-owned PayAITradeExecutor
 * (Uniswap V3 + Kuru), instead of straight at the router. The executor takes a
 * 0.25% fee from the GROSS input and swaps only the NET, so every quote/minOut
 * here is sized on the NET — matching exactly what the contract does on-chain
 * (proven by the Gate 4 canaries). Nad.Fun is intentionally NOT served here; it
 * stays on its own direct route (see lib/monad/tradeQuote.ts's dispatch).
 *
 * Gated by config.tradeExecutorEnabled() at the call site — with the flag off
 * (or no address configured) none of this runs and trades keep using the
 * existing direct-to-router path. Reuses swap.ts's quoteBestUniswapTier /
 * minOutWei / estimatePriceImpact and kuruSwap.ts's quoteKuruForExecutor rather
 * than re-deriving any quote/sizing logic. Server-only; never signs or submits.
 */
import "server-only";
import { type Address, encodeFunctionData, parseUnits, formatUnits, decodeEventLog, type Log } from "viem";
import { getPublicClient } from "./wallet";
import { getPayAITradeExecutor, getWrappedNative } from "./config";
import { quoteBestUniswapTier, minOutWei, estimatePriceImpact, ERC20_ABI, type UnsignedStep } from "./swap";
import { quoteKuruForExecutor } from "./kuruSwap";
import { normalizeDecimalString } from "./verify";

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
/** Trade deadline for the Uniswap adapter (the executor requires now <= deadline). */
const DEADLINE_SECONDS = 600;

/** Only the executor functions/events this module actually calls or decodes. */
export const TRADE_EXECUTOR_ABI = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "allowedKuruMarket", stateMutability: "view", inputs: [{ name: "market", type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "tradeUniswapExactInput", stateMutability: "payable",
    inputs: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "poolFee", type: "uint24" },
      { name: "grossAmountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "tradeKuruExactInput", stateMutability: "payable",
    inputs: [
      { name: "market", type: "address" }, { name: "isBuy", type: "bool" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
      { name: "kuruSize", type: "uint96" }, { name: "grossAmountIn", type: "uint256" }, { name: "minOut", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event", name: "TradeExecuted",
    inputs: [
      { name: "tradeId", type: "uint256", indexed: true }, { name: "user", type: "address", indexed: true },
      { name: "venue", type: "uint8", indexed: false }, { name: "tokenIn", type: "address", indexed: false }, { name: "tokenOut", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false }, { name: "amountOut", type: "uint256", indexed: false }, { name: "feeAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Short-TTL cache for the on-chain fee (the Safe can change it; a stale value
 *  would only slightly mis-estimate the preview — the build re-reads it too). */
let feeBpsCache: { bps: number; at: number } | null = null;
const FEE_TTL_MS = 60_000;

/** Reads the executor's live feeBps (basis points). Falls back to 25 (the
 *  deployed value) only when no executor is configured — a path that never
 *  actually routes a trade, since tradeExecutorEnabled() gates it. */
export async function getExecutorFeeBps(): Promise<number> {
  const exec = getPayAITradeExecutor();
  if (!exec) return 25;
  const now = Date.now();
  if (feeBpsCache && now - feeBpsCache.at < FEE_TTL_MS) return feeBpsCache.bps;
  const pub = getPublicClient();
  const bps = Number(await pub.readContract({ address: exec, abi: TRADE_EXECUTOR_ABI, functionName: "feeBps" }));
  feeBpsCache = { bps, at: now };
  return bps;
}

/** gross → (fee, net) with the executor's flooring integer math (fee never
 *  over-charges), matching _pullAndFee on-chain. */
export function applyExecutorFee(grossWei: bigint, feeBps: number): { feeWei: bigint; netWei: bigint } {
  const feeWei = (grossWei * BigInt(feeBps)) / 10000n;
  return { feeWei, netWei: grossWei - feeWei };
}

/** Is this Kuru market on the executor's Safe-controlled allowlist? A trade
 *  can only route through the executor's Kuru adapter for an allowlisted
 *  market — otherwise the caller falls back to the direct Kuru path. */
export async function isKuruMarketAllowed(market: Address): Promise<boolean> {
  const exec = getPayAITradeExecutor();
  if (!exec) return false;
  const pub = getPublicClient();
  return (await pub.readContract({ address: exec, abi: TRADE_EXECUTOR_ABI, functionName: "allowedKuruMarket", args: [market] })) as boolean;
}

export interface ExecutorPlan {
  steps: UnsignedStep[];
  /** Human, NET (post-fee) expected output — what the executor will actually deliver. */
  amountOut: string;
  priceImpact: string | null;
  feeBps: number;
  /** Human, fee amount in INPUT-token units. */
  feeAmount: string;
}

/**
 * Uniswap V3 exact-input through the executor. `tokenIn`/`tokenOut` are the
 * ORIGINAL sides (native MON keeps its own decimals; the executor wraps/unwraps
 * via WMON itself and is passed address(0) for a native leg). Quotes the NET on
 * the pool-side addresses (WMON for a native leg), sets minOut from the net.
 */
export async function buildUniswapExecutorPlan(
  tokenIn: Address, tokenInSymbol: string, tokenInDecimals: number, tokenInIsNative: boolean,
  tokenOut: Address, tokenOutSymbol: string, tokenOutDecimals: number, tokenOutIsNative: boolean,
  amount: string, slippage: number, wallet: Address,
): Promise<ExecutorPlan> {
  const exec = getPayAITradeExecutor();
  if (!exec) throw new Error("The trade executor isn't configured right now.");
  const wmon = getWrappedNative();
  if ((tokenInIsNative || tokenOutIsNative) && !wmon) throw new Error("WMON isn't configured for native-MON trades right now.");

  const grossWei = parseUnits(normalizeDecimalString(amount, tokenInDecimals), tokenInDecimals);
  const feeBps = await getExecutorFeeBps();
  const { feeWei, netWei } = applyExecutorFee(grossWei, feeBps);

  const quoteIn = (tokenInIsNative ? wmon! : tokenIn);
  const quoteOut = (tokenOutIsNative ? wmon! : tokenOut);
  const best = await quoteBestUniswapTier(quoteIn, quoteOut, netWei);
  if (!best) throw new Error(`No usable trading route found for ${tokenInSymbol} → ${tokenOutSymbol} right now.`);

  const pub = getPublicClient();
  const priceImpact = await estimatePriceImpact(pub, quoteIn, quoteOut, best.fee, netWei, best.amountOut);
  const minOut = minOutWei(best.amountOut, slippage);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

  const steps: UnsignedStep[] = [];
  if (!tokenInIsNative) {
    const allowance = (await pub.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: "allowance", args: [wallet, exec] })) as bigint;
    if (allowance < grossWei) {
      steps.push({
        kind: "approve",
        label: `Approve ${amount} ${tokenInSymbol} for the trade`,
        tx: { to: tokenIn, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [exec, grossWei] }), value: "0x0" },
      });
    }
  }
  steps.push({
    kind: "swap",
    label: `Trade ${amount} ${tokenInSymbol} for ${tokenOutSymbol}`,
    tx: {
      to: exec,
      data: encodeFunctionData({
        abi: TRADE_EXECUTOR_ABI, functionName: "tradeUniswapExactInput",
        args: [tokenInIsNative ? NATIVE : tokenIn, tokenOutIsNative ? NATIVE : tokenOut, best.fee, grossWei, minOut, deadline],
      }),
      value: tokenInIsNative ? `0x${grossWei.toString(16)}` : "0x0",
    },
  });

  return {
    steps,
    amountOut: formatUnits(best.amountOut, tokenOutDecimals),
    priceImpact: priceImpact != null ? `${(priceImpact * 100).toFixed(2)}%` : null,
    feeBps,
    feeAmount: formatUnits(feeWei, tokenInDecimals),
  };
}

/**
 * Kuru exact-input through the executor. Resolves + sizes the market on the NET
 * via quoteKuruForExecutor(), then builds the executor call (approve the
 * executor for the GROSS input token when it's an ERC-20; attach the gross as
 * value when native). Returns null when Kuru doesn't serve the pair OR the
 * resolved market isn't on the executor's allowlist — the caller then falls
 * back to the existing direct path.
 */
export async function buildKuruExecutorPlan(
  fromSymbol: string, toSymbol: string, inputDecimals: number,
  amount: string, slippage: number, wallet: Address,
): Promise<ExecutorPlan | null> {
  const exec = getPayAITradeExecutor();
  if (!exec) return null;
  const grossWei = parseUnits(normalizeDecimalString(amount, inputDecimals), inputDecimals);
  const feeBps = await getExecutorFeeBps();
  const { feeWei, netWei } = applyExecutorFee(grossWei, feeBps);
  const netHuman = Number(formatUnits(netWei, inputDecimals));

  const kq = await quoteKuruForExecutor(fromSymbol, toSymbol, netHuman, slippage);
  if (!kq) return null;
  if (!(await isKuruMarketAllowed(kq.marketAddress))) return null; // not allowlisted → direct fallback

  const tokenIn = kq.debitIsNative ? NATIVE : kq.debitAddress;
  const tokenOut = kq.outIsNative ? NATIVE : kq.outAddress;

  const pub = getPublicClient();
  const steps: UnsignedStep[] = [];
  if (!kq.debitIsNative) {
    const allowance = (await pub.readContract({ address: kq.debitAddress, abi: ERC20_ABI, functionName: "allowance", args: [wallet, exec] })) as bigint;
    if (allowance < grossWei) {
      steps.push({
        kind: "approve",
        label: `Approve ${amount} ${fromSymbol} for the trade`,
        tx: { to: kq.debitAddress, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [exec, grossWei] }), value: "0x0" },
      });
    }
  }
  steps.push({
    kind: "swap",
    label: `Trade ${amount} ${fromSymbol} for ${toSymbol}`,
    tx: {
      to: exec,
      data: encodeFunctionData({
        abi: TRADE_EXECUTOR_ABI, functionName: "tradeKuruExactInput",
        args: [kq.marketAddress, kq.isBuy, tokenIn, tokenOut, kq.kuruSize, grossWei, kq.minOutWei],
      }),
      value: kq.debitIsNative ? `0x${grossWei.toString(16)}` : "0x0",
    },
  });

  return {
    steps,
    amountOut: formatUnits(kq.expectedOutWei, kq.outDecimals),
    priceImpact: null,
    feeBps,
    feeAmount: formatUnits(feeWei, inputDecimals),
  };
}

export interface DecodedTradeExecuted {
  tradeId: bigint;
  user: Address;
  venue: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/**
 * Decodes the executor's TradeExecuted event from a mined tx's logs — the
 * authoritative record of what actually happened (real delivered amountOut +
 * fee), so PayAI confirms a trade from the event, not from the pre-trade quote.
 * Returns null if the tx has no such event (e.g. it went through the direct
 * path, or the executor isn't the one that emitted it).
 */
export function decodeTradeExecuted(logs: readonly Log[]): DecodedTradeExecuted | null {
  const exec = getPayAITradeExecutor();
  if (!exec) return null;
  const execLower = exec.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== execLower) continue;
    try {
      const parsed = decodeEventLog({ abi: TRADE_EXECUTOR_ABI, data: log.data, topics: log.topics });
      if (parsed.eventName !== "TradeExecuted") continue;
      const a = parsed.args as unknown as DecodedTradeExecuted;
      return {
        tradeId: a.tradeId, user: a.user, venue: Number(a.venue),
        tokenIn: a.tokenIn, tokenOut: a.tokenOut, amountIn: a.amountIn, amountOut: a.amountOut, feeAmount: a.feeAmount,
      };
    } catch {
      // not this event — keep scanning
    }
  }
  return null;
}
