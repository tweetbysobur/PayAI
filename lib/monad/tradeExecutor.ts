/**
 * PayAITradeExecutor integration — Gate 5 (Uniswap + Kuru) / Gate 7 (+ Nad.Fun).
 *
 * Builds the unsigned `approve` + `swap` steps for an INTERACTIVE, user-signed
 * trade that routes through a deployed, Safe-owned PayAITradeExecutor, instead
 * of straight at the router. The executor takes a fee from the GROSS input and
 * swaps only the NET, so every quote/minOut here is sized on the NET — matching
 * exactly what the contract does on-chain (proven by the Gate 4 canaries).
 *
 * Two executor deployments can be configured side by side:
 *   - V1 (0xF17a916280321Ddb657c8EDd26B2a729F6E63b69, Gate 3/4/5) — Uniswap +
 *     Kuru only. Production default while V2 is untested.
 *   - V2 (Gate 7) — a SEPARATE, non-upgradeable deployment adding Nad.Fun as a
 *     third venue. When configured+enabled it serves ALL THREE venues,
 *     superseding V1 for Uniswap/Kuru; V1 itself is never modified.
 * selectExecutor() below is the single fail-closed dispatch point — see its
 * own doc. Nad.Fun is NEVER served by V1 (it predates Nad.Fun support); with
 * neither executor selected for a venue, that venue keeps using its existing
 * direct-to-router path.
 *
 * Reuses swap.ts's quoteBestUniswapTier/minOutWei/estimatePriceImpact,
 * kuruSwap.ts's quoteKuruForExecutor, and nadfun.ts's nadFunQuote (the SAME
 * Lens-backed quote engine the direct Nad.Fun path already uses — never a
 * second quote engine). Server-only; never signs or submits.
 */
import "server-only";
import { type Address, encodeFunctionData, parseUnits, formatUnits, decodeEventLog, type Log } from "viem";
import { getPublicClient } from "./wallet";
import {
  getPayAITradeExecutor, getPayAITradeExecutorV2, tradeExecutorEnabled, tradeExecutorV2Enabled, getWrappedNative,
} from "./config";
import { quoteBestUniswapTier, minOutWei, estimatePriceImpact, ERC20_ABI, type UnsignedStep } from "./swap";
import { quoteKuruForExecutor } from "./kuruSwap";
import { nadFunQuote } from "./nadfun";
import { normalizeDecimalString } from "./verify";
import { feeOnTop } from "@/lib/payment/feeOnTop";

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
/** Trade deadline for the Uniswap/Nad.Fun adapters (the executor requires now <= deadline). */
const DEADLINE_SECONDS = 600;

export type ExecutorVenue = "uniswap" | "kuru" | "nadfun";

/**
 * Resolves which deployed executor (if any) should serve `venue` right now —
 * the single fail-closed dispatch point every builder/reader below is called
 * through. V2, when configured AND explicitly enabled, serves all three
 * venues (superseding V1 for Uniswap/Kuru while it's on). Otherwise V1, when
 * configured AND enabled, serves Uniswap/Kuru only — it was never built with
 * Nad.Fun support. Returns null when neither applies, so the caller falls
 * back to the existing direct-to-router path for that venue; this is exactly
 * how Nad.Fun behaves today (V1 never serves it) and continues to behave
 * until V2 is deliberately turned on.
 */
export function selectExecutor(venue: ExecutorVenue): Address | null {
  if (tradeExecutorV2Enabled()) {
    const v2 = getPayAITradeExecutorV2();
    if (v2) return v2;
  }
  if (venue !== "nadfun" && tradeExecutorEnabled()) {
    const v1 = getPayAITradeExecutor();
    if (v1) return v1;
  }
  return null;
}

/** Only the executor functions/events this module actually calls or decodes.
 *  V1 doesn't implement tradeNadFunExactInput/allowedNadFunRouter — harmless,
 *  since selectExecutor() never returns V1's address for the "nadfun" venue,
 *  so those two fragments are only ever encoded/read against a V2 address. */
export const TRADE_EXECUTOR_ABI = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "allowedKuruMarket", stateMutability: "view", inputs: [{ name: "market", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowedNadFunRouter", stateMutability: "view", inputs: [{ name: "router", type: "address" }], outputs: [{ type: "bool" }] },
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
    type: "function", name: "tradeNadFunExactInput", stateMutability: "payable",
    inputs: [
      { name: "router", type: "address" }, { name: "isBuy", type: "bool" }, { name: "token", type: "address" },
      { name: "grossAmountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "deadline", type: "uint256" },
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

/** Short-TTL cache for an executor's live feeBps (the Safe can change it; a
 *  stale value would only slightly mis-estimate the preview — the build
 *  re-reads it too). Keyed per executor address since V1 and V2 can have
 *  independently-configured fees. */
const feeBpsCache = new Map<string, { bps: number; at: number }>();
const FEE_TTL_MS = 60_000;

/** Reads `execAddr`'s live feeBps (basis points). */
export async function getExecutorFeeBps(execAddr: Address): Promise<number> {
  const key = execAddr.toLowerCase();
  const now = Date.now();
  const cached = feeBpsCache.get(key);
  if (cached && now - cached.at < FEE_TTL_MS) return cached.bps;
  const pub = getPublicClient();
  const bps = Number(await pub.readContract({ address: execAddr, abi: TRADE_EXECUTOR_ABI, functionName: "feeBps" }));
  feeBpsCache.set(key, { bps, at: now });
  return bps;
}

/** gross → (fee, net) with the executor's flooring integer math (fee never
 *  over-charges), matching _pullAndFee on-chain. */
export function applyExecutorFee(grossWei: bigint, feeBps: number): { feeWei: bigint; netWei: bigint } {
  const feeWei = (grossWei * BigInt(feeBps)) / 10000n;
  return { feeWei, netWei: grossWei - feeWei };
}

/** Is this Kuru market on `execAddr`'s Safe-controlled allowlist? A trade can
 *  only route through the executor's Kuru adapter for an allowlisted market —
 *  otherwise the caller falls back to the direct Kuru path. */
export async function isKuruMarketAllowed(execAddr: Address, market: Address): Promise<boolean> {
  const pub = getPublicClient();
  return (await pub.readContract({ address: execAddr, abi: TRADE_EXECUTOR_ABI, functionName: "allowedKuruMarket", args: [market] })) as boolean;
}

/** Is this Nad.Fun router on `execAddr`'s Safe-controlled allowlist? Mirrors
 *  isKuruMarketAllowed exactly — the app never trusts the Lens's router pick
 *  as safe to call without the executor independently re-validating it. */
export async function isNadFunRouterAllowed(execAddr: Address, router: Address): Promise<boolean> {
  const pub = getPublicClient();
  return (await pub.readContract({ address: execAddr, abi: TRADE_EXECUTOR_ABI, functionName: "allowedNadFunRouter", args: [router] })) as boolean;
}

/**
 * PayAI's trade fee is ON TOP of the amount swapped (lib/payment/feeOnTop.ts):
 * the gross handed to the executor is the smallest whose net — the
 * executor's own floor fee taken out — is exactly `net`. Checked against
 * applyExecutorFee, the on-chain math, so the two can never disagree.
 */
export function executorGross(net: bigint, feeBps: number): { gross: bigint; fee: bigint } {
  const { gross, fee } = feeOnTop(net, feeBps);
  if (applyExecutorFee(gross, feeBps).netWei !== net) throw new Error("PayAI's trade fee couldn't be applied to this amount.");
  return { gross, fee };
}

export interface ExecutorPlan {
  steps: UnsignedStep[];
  /** Human, NET (post-fee) expected output — what the executor will actually deliver. */
  amountOut: string;
  priceImpact: string | null;
  feeBps: number;
  /** Human, fee amount in INPUT-token units — on top of the amount swapped. */
  feeAmount: string;
}

/**
 * Uniswap V3 exact-input through `execAddr`. `tokenIn`/`tokenOut` are the
 * ORIGINAL sides (native MON keeps its own decimals; the executor wraps/unwraps
 * via WMON itself and is passed address(0) for a native leg). Quotes the NET on
 * the pool-side addresses (WMON for a native leg), sets minOut from the net.
 */
export async function buildUniswapExecutorPlan(
  execAddr: Address,
  tokenIn: Address, tokenInSymbol: string, tokenInDecimals: number, tokenInIsNative: boolean,
  tokenOut: Address, tokenOutSymbol: string, tokenOutDecimals: number, tokenOutIsNative: boolean,
  amount: string, slippage: number, wallet: Address,
): Promise<ExecutorPlan> {
  const wmon = getWrappedNative();
  if ((tokenInIsNative || tokenOutIsNative) && !wmon) throw new Error("WMON isn't configured for native-MON trades right now.");

  // `amount` is what gets SWAPPED; PayAI's fee is on top (feeOnTop), so the
  // executor is handed the gross whose net is exactly that amount.
  const netWei = parseUnits(normalizeDecimalString(amount, tokenInDecimals), tokenInDecimals);
  const feeBps = await getExecutorFeeBps(execAddr);
  const { gross: grossWei, fee: feeWei } = executorGross(netWei, feeBps);
  const grossLabel = formatUnits(grossWei, tokenInDecimals);

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
    const allowance = (await pub.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: "allowance", args: [wallet, execAddr] })) as bigint;
    if (allowance < grossWei) {
      steps.push({
        kind: "approve",
        label: `Approve ${grossLabel} ${tokenInSymbol} for the trade`,
        tx: { to: tokenIn, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [execAddr, grossWei] }), value: "0x0" },
      });
    }
  }
  steps.push({
    kind: "swap",
    label: `Trade ${amount} ${tokenInSymbol} for ${tokenOutSymbol}`,
    tx: {
      to: execAddr,
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
 * Kuru exact-input through `execAddr`. Resolves + sizes the market on the NET
 * via quoteKuruForExecutor(), then builds the executor call (approve the
 * executor for the GROSS input token when it's an ERC-20; attach the gross as
 * value when native). Returns null when Kuru doesn't serve the pair OR the
 * resolved market isn't on `execAddr`'s allowlist — the caller then falls
 * back to the existing direct path.
 */
export async function buildKuruExecutorPlan(
  execAddr: Address,
  fromSymbol: string, toSymbol: string, inputDecimals: number,
  amount: string, slippage: number, wallet: Address,
): Promise<ExecutorPlan | null> {
  const netWei = parseUnits(normalizeDecimalString(amount, inputDecimals), inputDecimals);
  const feeBps = await getExecutorFeeBps(execAddr);
  const { gross: grossWei, fee: feeWei } = executorGross(netWei, feeBps);
  const netHuman = Number(formatUnits(netWei, inputDecimals));
  const grossLabel = formatUnits(grossWei, inputDecimals);

  const kq = await quoteKuruForExecutor(fromSymbol, toSymbol, netHuman, slippage);
  if (!kq) return null;
  if (!(await isKuruMarketAllowed(execAddr, kq.marketAddress))) return null; // not allowlisted → direct fallback

  const tokenIn = kq.debitIsNative ? NATIVE : kq.debitAddress;
  const tokenOut = kq.outIsNative ? NATIVE : kq.outAddress;

  const pub = getPublicClient();
  const steps: UnsignedStep[] = [];
  if (!kq.debitIsNative) {
    const allowance = (await pub.readContract({ address: kq.debitAddress, abi: ERC20_ABI, functionName: "allowance", args: [wallet, execAddr] })) as bigint;
    if (allowance < grossWei) {
      steps.push({
        kind: "approve",
        label: `Approve ${grossLabel} ${fromSymbol} for the trade`,
        tx: { to: kq.debitAddress, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [execAddr, grossWei] }), value: "0x0" },
      });
    }
  }
  steps.push({
    kind: "swap",
    label: `Trade ${amount} ${fromSymbol} for ${toSymbol}`,
    tx: {
      to: execAddr,
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

/**
 * Nad.Fun exact-input through `execAddr` (V2 only — see selectExecutor()).
 * `token` is always the non-MON side, regardless of direction (matches the
 * executor's own tradeNadFunExactInput signature and nadfun.ts's convention).
 *
 * Reuses nadFunQuote() — the SAME Lens-backed quote engine the direct Nad.Fun
 * path already uses — to resolve the router AND size the trade on the NET
 * (post-fee) amount, right before building calldata (never a stale quote,
 * matching this codebase's "always re-quote right before signing" principle
 * — see buildKuruExecutorPlan/prepareTradeExecution). Returns null when
 * Nad.Fun doesn't serve this token/direction OR the router the Lens named
 * isn't on `execAddr`'s Safe-controlled allowlist — the caller then falls
 * back to the existing direct Nad.Fun path, exactly like a non-allowlisted
 * Kuru market does.
 */
export async function buildNadFunExecutorPlan(
  execAddr: Address,
  token: Address, tokenSymbol: string, tokenDecimals: number, isBuy: boolean,
  amount: string, slippage: number, wallet: Address,
): Promise<ExecutorPlan | null> {
  const inputDecimals = isBuy ? 18 : tokenDecimals; // spending MON to buy, or spending the token to sell
  const outputDecimals = isBuy ? tokenDecimals : 18;
  const netWei = parseUnits(normalizeDecimalString(amount, inputDecimals), inputDecimals);
  const feeBps = await getExecutorFeeBps(execAddr);
  const { gross: grossWei, fee: feeWei } = executorGross(netWei, feeBps);
  const netHuman = formatUnits(netWei, inputDecimals);
  const grossLabel = formatUnits(grossWei, inputDecimals);

  const q = await nadFunQuote(token, tokenDecimals, netHuman, isBuy);
  if (!q) return null;
  if (!(await isNadFunRouterAllowed(execAddr, q.router))) return null; // not allowlisted → direct fallback

  const amountOutWei = parseUnits(q.amountOut, outputDecimals); // exact round-trip of nadFunQuote's own formatted output
  const minOut = minOutWei(amountOutWei, slippage);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

  const steps: UnsignedStep[] = [];
  if (!isBuy) {
    const pub = getPublicClient();
    const allowance = (await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [wallet, execAddr] })) as bigint;
    if (allowance < grossWei) {
      steps.push({
        kind: "approve",
        label: `Approve ${grossLabel} ${tokenSymbol} for the trade`,
        tx: { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [execAddr, grossWei] }), value: "0x0" },
      });
    }
  }
  steps.push({
    kind: "swap",
    label: isBuy ? `Buy ${tokenSymbol} on Nad.Fun` : `Sell ${amount} ${tokenSymbol} on Nad.Fun`,
    tx: {
      to: execAddr,
      data: encodeFunctionData({
        abi: TRADE_EXECUTOR_ABI, functionName: "tradeNadFunExactInput",
        args: [q.router, isBuy, token, grossWei, minOut, deadline],
      }),
      value: isBuy ? `0x${grossWei.toString(16)}` : "0x0",
    },
  });

  return { steps, amountOut: q.amountOut, priceImpact: null, feeBps, feeAmount: formatUnits(feeWei, inputDecimals) };
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
 * Decodes a TradeExecuted event from a mined tx's logs — the authoritative
 * record of what actually happened (real delivered amountOut + fee), so PayAI
 * confirms a trade from the event, not from the pre-trade quote. Recognizes an
 * emitter from EITHER configured executor (V1 or V2) — a trade that routed
 * through V1 must keep confirming exactly as it does in production today;
 * this only ADDS recognition of V2 once it's configured, never narrows what
 * V1 already confirms correctly. Returns null if the tx has no such event
 * from either configured executor (e.g. it went through a direct path).
 */
export function decodeTradeExecuted(logs: readonly Log[]): DecodedTradeExecuted | null {
  const candidates = [getPayAITradeExecutor(), getPayAITradeExecutorV2()]
    .filter((a): a is Address => a !== null)
    .map((a) => a.toLowerCase());
  if (candidates.length === 0) return null;
  for (const log of logs) {
    if (!candidates.includes(log.address.toLowerCase())) continue;
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
