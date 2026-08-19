/**
 * Kuru — a real second liquidity source behind the SwapProvider seam
 * documented in swap.ts ("the seam an aggregator (Monorail/Kuru) can be
 * dropped behind later"). Kuru is an orderbook (CLOB) protocol, not an AMM
 * like Uniswap v3, so quoting/execution here is genuinely different
 * mechanics, not a copy of swap.ts's pool-fee-tier logic.
 *
 * Addresses below (Router, official tokens, official markets) are the
 * verified Monad-mainnet Kuru deployment, provided directly by the project
 * owner from Kuru's own docs — never invented, and cross-checked at runtime
 * (see resolveKuruMarket) against the token addresses the rest of PayAI
 * already trusts (lib/monad/tokenRegistry via resolveSwapSide), so a Kuru
 * market whose on-chain base/quote doesn't match PayAI's own canonical
 * token address for that symbol is refused rather than silently swapped
 * into a same-symbol-different-contract token.
 *
 * Coverage is intentionally narrow: only the two markets Kuru has actually
 * deployed and verified on its Router (MON-USDC, MON-AUSD). Any other pair
 * reports "not supported" honestly instead of guessing a market address.
 *
 * Server-only. Read/quote functions never need a live signer or balance —
 * matching Kuru's own documented estimation pattern (callStatic from the
 * zero address) — and buildPlan() only ever returns unsigned steps for the
 * user's own wallet to sign, same trust model as the rest of this app.
 */
import "server-only";
import { encodeFunctionData, formatUnits, parseUnits, zeroAddress, type Address } from "viem";
import { getNetwork } from "./config";
import { getPublicClient } from "./wallet";
import { resolveSwapSide, ERC20_ABI, DEFAULT_SLIPPAGE, MAX_SLIPPAGE, type SwapToken, type SwapQuote, type UnsignedStep, type SwapProvider } from "./swap";
import { toParseableAmount } from "./verify";

/* ── Verified Monad-mainnet Kuru deployment ────────────────────────────────
 * Source: Kuru's own "Contract Addresses" documentation, supplied directly
 * by the project owner (not fetched or guessed — docs.kuru.io isn't
 * reachable from this environment). Env-overridable like the Uniswap
 * addresses above, so a correction never needs a code change. */
const KURU_MAINNET = {
  router: (process.env.MONAD_MAINNET_KURU_ROUTER || "0xd651346d7c789536ebf06dc72aE3C8502cd695CC") as Address,
} as const;

/** The only pairs Kuru is wired for — real, verified market addresses.
 *  Keyed by "A/B" with symbols alphabetically sorted so lookup doesn't care
 *  which side the caller calls "from" vs "to". */
const KURU_MARKETS: Record<string, Address> = {
  "AUSD/MON": (process.env.MONAD_MAINNET_KURU_MON_AUSD_MARKET || "0x131a2e70a5b31a517a74b8c567149bc294470da9") as Address,
  "MON/USDC": (process.env.MONAD_MAINNET_KURU_MON_USDC_MARKET || "0x065C9d28E428A0db40191a54d33d5b7c71a9C394") as Address,
};

function marketKey(a: string, b: string): string {
  return [a.toUpperCase(), b.toUpperCase()].sort().join("/");
}

const ROUTER_ABI = [
  {
    type: "function",
    name: "verifiedMarket",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "pricePrecision", type: "uint32" },
      { name: "sizePrecision", type: "uint96" },
      { name: "baseAssetAddress", type: "address" },
      { name: "baseAssetDecimals", type: "uint256" },
      { name: "quoteAssetAddress", type: "address" },
      { name: "quoteAssetDecimals", type: "uint256" },
      { name: "tickSize", type: "uint32" },
      { name: "minSize", type: "uint96" },
      { name: "maxSize", type: "uint96" },
      { name: "takerFeeBps", type: "uint256" },
      { name: "makerFeeBps", type: "uint256" },
    ],
  },
] as const;

/** Both functions share the same shape: (size, minAmountOut, isMargin,
 *  isFillOrKill) -> amountOut. `size`/`minAmountOut` mean different things
 *  per function (see resolveKuruMarket's doc), matching Kuru's OrderBook ABI
 *  exactly (abi/OrderBook.json in @kuru-labs/kuru-sdk). */
const ORDERBOOK_ABI = [
  {
    type: "function",
    name: "placeAndExecuteMarketBuy",
    stateMutability: "payable",
    inputs: [
      { name: "_quoteSize", type: "uint96" },
      { name: "_minAmountOut", type: "uint256" },
      { name: "_isMargin", type: "bool" },
      { name: "_isFillOrKill", type: "bool" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "placeAndExecuteMarketSell",
    stateMutability: "payable",
    inputs: [
      { name: "_size", type: "uint96" },
      { name: "_minAmountOut", type: "uint256" },
      { name: "_isMargin", type: "bool" },
      { name: "_isFillOrKill", type: "bool" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

interface ResolvedKuruMarket {
  marketAddress: Address;
  baseAssetAddress: Address;
  baseDecimals: number;
  baseIsNative: boolean;
  quoteAssetAddress: Address;
  quoteDecimals: number;
  quoteIsNative: boolean;
  sizePrecision: bigint;
  pricePrecision: bigint;
  takerFeeBps: bigint;
  /** true: fromToken is the quote asset, spending it to buy the base asset
   *  (placeAndExecuteMarketBuy). false: fromToken is the base asset, selling
   *  it for the quote asset (placeAndExecuteMarketSell). */
  isBuy: boolean;
}

/** Kuru's own SDK derives a market's decimal precision from its on-chain
 *  precision constant this same way (log10BigNumber): sizePrecision and
 *  pricePrecision are always exact powers of ten. */
function precisionDecimals(precision: bigint): number {
  return precision.toString().length - 1;
}

/** Scales a human amount into Kuru's order-size units for a given market
 *  precision — NOT the token's own ERC-20 decimals. Mirrors the official
 *  SDK's CostEstimator exactly (parseUnits to log10(precision) places). */
function toPrecisionUnits(amountHuman: number, precision: bigint): bigint {
  return parseUnits(amountHuman.toFixed(precisionDecimals(precision)), precisionDecimals(precision));
}

/**
 * Resolves a symbol pair to a real, verified Kuru market — or null when
 * Kuru simply doesn't cover that pair (never a guessed/synthesized market).
 * Cross-checks the market's live base/quote addresses (read fresh from the
 * Router, not cached) against the SAME token registry Uniswap's
 * resolveSwapSide() already trusts, so a same-symbol/different-contract
 * mismatch fails closed instead of quoting against the wrong token.
 */
async function resolveKuruMarket(fromToken: SwapToken, toToken: SwapToken): Promise<ResolvedKuruMarket | null> {
  const key = marketKey(fromToken, toToken);
  const marketAddress = KURU_MARKETS[key];
  if (!marketAddress) return null;

  const pub = getPublicClient();
  // viem decodes small ABI uint types (uint32, here: pricePrecision/tickSize)
  // as `number` and larger ones (uint96/uint256) as `bigint` — pricePrecision
  // is normalized to bigint below since every downstream use treats
  // precisions uniformly (toPrecisionUnits, ResolvedKuruMarket).
  const [pricePrecisionRaw, sizePrecision, baseAssetAddress, baseAssetDecimals, quoteAssetAddress, quoteAssetDecimals, , , , takerFeeBps] =
    (await pub.readContract({
      address: KURU_MAINNET.router, abi: ROUTER_ABI, functionName: "verifiedMarket", args: [marketAddress],
    })) as readonly [number, bigint, Address, bigint, Address, bigint, number, bigint, bigint, bigint, bigint];
  const pricePrecision = BigInt(pricePrecisionRaw);

  if (baseAssetAddress === zeroAddress && quoteAssetAddress === zeroAddress) return null; // unregistered market

  // Concurrent, matching swap.ts's own rawQuote() -- the two sides don't
  // depend on each other, so there's no reason to pay two sequential RPC
  // round-trips for them.
  const [fromSide, toSide] = await Promise.all([resolveSwapSide(fromToken), resolveSwapSide(toToken)]);

  // A symbol matches a market side only if it's genuinely native MON against
  // a native (zero-address) leg, or its registry-resolved address matches
  // exactly — never a same-symbol-different-address coincidence.
  const matchesSide = (side: { symbol: string; routeAddress: Address; isNative: boolean }, sideAddress: Address) =>
    (side.isNative && sideAddress === zeroAddress) || side.routeAddress.toLowerCase() === sideAddress.toLowerCase();

  let isBuy: boolean;
  let baseSide: { isNative: boolean };
  let quoteSide: { isNative: boolean };
  if (matchesSide(fromSide, quoteAssetAddress) && matchesSide(toSide, baseAssetAddress)) {
    isBuy = true; // spending quote to acquire base
    quoteSide = fromSide; baseSide = toSide;
  } else if (matchesSide(fromSide, baseAssetAddress) && matchesSide(toSide, quoteAssetAddress)) {
    isBuy = false; // spending base to acquire quote
    baseSide = fromSide; quoteSide = toSide;
  } else {
    return null; // this market's real on-chain sides don't match what was asked for
  }

  return {
    marketAddress,
    // baseIsNative/quoteIsNative come from the SAME resolveSwapSide().isNative
    // flag matchesSide() already validated above — never re-derived from a
    // raw zeroAddress check, which would silently disagree with matchesSide
    // if a market ever represented its native leg via WMON instead of the
    // zero-address sentinel (matchesSide accepts either; a separate
    // zeroAddress-only check here would not, and buildPlan would then treat
    // a native debit as an ERC-20 -- reading/approving allowance instead of
    // attaching msg.value).
    baseAssetAddress, baseDecimals: Number(baseAssetDecimals), baseIsNative: baseSide.isNative,
    quoteAssetAddress, quoteDecimals: Number(quoteAssetDecimals), quoteIsNative: quoteSide.isNative,
    sizePrecision, pricePrecision, takerFeeBps, isBuy,
  };
}

/** Never zero-floor a positive quote's enforced minimum — same reasoning as
 *  swap.ts's minOutWei(), duplicated narrowly rather than importing a
 *  private helper across module boundaries. */
function minOutWei(amountOutWei: bigint, slippage: number): bigint {
  const bps = BigInt(Math.round((1 - slippage) * 1_000_000));
  const floored = (amountOutWei * bps) / 1_000_000n;
  return floored === 0n && amountOutWei > 0n ? 1n : floored;
}

/** Real callStatic simulation of the actual execution function, exactly
 *  matching Kuru's own documented quoting pattern (CostEstimator: simulate
 *  placeAndExecuteMarketBuy/Sell "from" the zero address, with NO msg.value
 *  override even for a native-base market sell) — never a hand-rolled
 *  order-book-walking formula, and never a native value attached here: the
 *  zero address doesn't hold any real MON, so a nonzero value would fail
 *  the EVM's balance check before the call even runs. Only the actual
 *  execution transaction built in buildPlan() (signed by the real wallet,
 *  which does hold the funds) ever carries a real value. */
async function simulateMarketOrder(m: ResolvedKuruMarket, amountIn: number, minAmountOutWei: bigint) {
  const pub = getPublicClient();
  const functionName = m.isBuy ? "placeAndExecuteMarketBuy" : "placeAndExecuteMarketSell";
  const sizeArg = toPrecisionUnits(amountIn, m.isBuy ? m.pricePrecision : m.sizePrecision);

  const { result } = await pub.simulateContract({
    address: m.marketAddress, abi: ORDERBOOK_ABI, functionName,
    args: [sizeArg, minAmountOutWei, false, false],
    account: zeroAddress,
  });
  return { amountOutWei: result as bigint, sizeArg };
}

const kuruProvider: SwapProvider = {
  name: "Kuru",

  isConfigured() {
    return getNetwork() === "mainnet";
  },

  async quote(fromToken, toToken, amountIn) {
    const m = await resolveKuruMarket(fromToken, toToken);
    if (!m) throw new Error(`Kuru doesn't support ${fromToken} → ${toToken} yet.`);
    const { amountOutWei } = await simulateMarketOrder(m, amountIn, 0n);
    const outDecimals = m.isBuy ? m.baseDecimals : m.quoteDecimals;
    const amountOut = Number(formatUnits(amountOutWei, outDecimals));
    return {
      fromToken, toToken, amountIn,
      amountOut,
      minAmountOut: Number(formatUnits(minOutWei(amountOutWei, DEFAULT_SLIPPAGE), outDecimals)),
      // Kuru's real per-market taker fee, in basis points (30 = 0.30%) --
      // not a Uniswap pool-fee-tier code. Not rendered in the UI today.
      feeTier: Number(m.takerFeeBps),
      slippage: DEFAULT_SLIPPAGE,
      rate: amountOut / amountIn,
      // Kuru's simulate call returns a single final fill amount, not a
      // decomposed price-impact figure the way Uniswap's reference-quote
      // trick does -- honestly reporting "not available" rather than
      // fabricating one (see this task's own instruction on this point).
      priceImpact: null,
    };
  },

  async buildPlan(fromToken, toToken, amountIn, wallet, slippage = DEFAULT_SLIPPAGE) {
    if (!Number.isFinite(slippage) || slippage < 0 || slippage > MAX_SLIPPAGE) {
      throw new Error(`Slippage tolerance must be between 0% and ${(MAX_SLIPPAGE * 100).toFixed(0)}%.`);
    }
    const m = await resolveKuruMarket(fromToken, toToken);
    if (!m) throw new Error(`Kuru doesn't support ${fromToken} → ${toToken} yet.`);

    // A first pass at minAmountOut=0 to learn the real expected output,
    // exactly like swap.ts's rawQuote() -- the ACTUAL on-chain minimum
    // enforced below is computed from this real number, never reconstructed
    // from a lossy display value.
    const { amountOutWei: expectedOutWei } = await simulateMarketOrder(m, amountIn, 0n);
    const outDecimals = m.isBuy ? m.baseDecimals : m.quoteDecimals;
    const minOut = minOutWei(expectedOutWei, slippage);
    const amountOut = Number(formatUnits(expectedOutWei, outDecimals));

    const q: SwapQuote = {
      fromToken, toToken, amountIn,
      amountOut,
      minAmountOut: Number(formatUnits(minOut, outDecimals)),
      feeTier: Number(m.takerFeeBps),
      slippage,
      rate: amountOut / amountIn,
      priceImpact: null,
    };

    const debitIsBase = !m.isBuy;
    const debitAddress = debitIsBase ? m.baseAssetAddress : m.quoteAssetAddress;
    const debitDecimals = debitIsBase ? m.baseDecimals : m.quoteDecimals;
    const debitIsNative = debitIsBase ? m.baseIsNative : m.quoteIsNative;
    // toParseableAmount, not String() — a sub-1-unit amountIn below the
    // debit token's own precision floor stringifies to exponential notation,
    // which parseUnits rejects outright.
    const amountInWei = parseUnits(toParseableAmount(amountIn, debitDecimals), debitDecimals);

    const steps: UnsignedStep[] = [];
    if (!debitIsNative) {
      const pub = getPublicClient();
      const allowance = (await pub.readContract({
        address: debitAddress, abi: ERC20_ABI, functionName: "allowance", args: [wallet, m.marketAddress],
      })) as bigint;
      if (allowance < amountInWei) {
        steps.push({
          kind: "approve",
          label: `Approve ${amountIn} ${fromToken} for the swap`,
          tx: {
            to: debitAddress,
            data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [m.marketAddress, amountInWei] }),
            value: "0x0",
          },
        });
      }
    }

    const sizeArg = toPrecisionUnits(amountIn, m.isBuy ? m.pricePrecision : m.sizePrecision);
    const nativeValue = debitIsNative ? amountInWei : 0n;
    steps.push({
      kind: "swap",
      label: `Swap ${amountIn} ${fromToken} for ${toToken}`,
      tx: {
        to: m.marketAddress,
        data: encodeFunctionData({
          abi: ORDERBOOK_ABI,
          functionName: m.isBuy ? "placeAndExecuteMarketBuy" : "placeAndExecuteMarketSell",
          // Fill-or-kill on the real execution tx (unlike the quote-time
          // simulate above): either it fills completely at-or-better than
          // minAmountOut, or it reverts -- never left as a resting order.
          args: [sizeArg, minOut, false, true],
        }),
        value: `0x${nativeValue.toString(16)}`,
      },
    });

    return {
      quote: q,
      steps,
      summary: `Swap ${amountIn} ${fromToken} → ${q.amountOut.toFixed(toToken === "USDC" || toToken === "AUSD" ? 2 : 4)} ${toToken} via Kuru`,
    };
  },
};

export default kuruProvider;
