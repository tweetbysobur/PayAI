/**
 * On-chain swap engine — natural-language "swap 1 MON to USDC" settled through a
 * real DEX on Monad mainnet, signed by the user's own wallet (non-custodial).
 *
 * Provider-agnostic by design: the SwapProvider interface below is the seam an
 * aggregator (Monorail/Kuru) can be dropped behind later. The shipping default
 * is Uniswap v3, whose Monad-mainnet deployment addresses are taken from
 * Uniswap's official developer docs (chain id 143) and overridable via env.
 *
 * What this module does NOT do: hold keys or broadcast. It only reads live
 * quotes and builds unsigned transactions for the wallet to sign — the same
 * trust model as the payment path.
 *
 * Server-only.
 */
import "server-only";
import { encodeFunctionData, formatUnits, parseUnits, type Address } from "viem";
import { getNetwork } from "./config";
import { getPublicClient } from "./wallet";
import { getStablecoin } from "./config";
import { getVerifiedTokens } from "./tokenRegistry";

/** A token SYMBOL. Any verified Monad token, resolved via resolveSwapSide()
 *  against the on-chain registry — no longer a two-token union. */
export type SwapToken = string;

/** Default slippage tolerance (0.5%) — overridable per request. */
export const DEFAULT_SLIPPAGE = 0.005;

/** Hard ceiling on slippage tolerance. Beyond this, amountOutMinimum is so
 *  low it stops being real protection against price movement between quote
 *  and execution — effectively an unprotected trade. */
export const MAX_SLIPPAGE = 0.5;

/** Hard ceiling on estimated price impact (how much the trade's OWN size
 *  moves the pool price, distinct from slippage). Beyond this the pool is
 *  almost certainly too thin for the requested size, or the quote itself is
 *  unreliable -- refuse to build a plan rather than let someone sign into a
 *  trade that's a bad idea regardless of slippage settings. */
export const MAX_PRICE_IMPACT = 0.15;

/* ── Verified Uniswap v3 deployment on Monad mainnet (chain 143) ──────────────
 * Source: Uniswap official docs — developers.uniswap.org/contracts/v3/reference/
 * deployments/monad-deployments. Each is env-overridable so a corrected address
 * never needs a code change. Swap is mainnet-only (this is where Uniswap is
 * deployed); on testnet the provider reports unconfigured rather than guess. */
const UNISWAP_MAINNET = {
  swapRouter02: (process.env.MONAD_MAINNET_UNISWAP_ROUTER || "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900") as Address,
  quoterV2: (process.env.MONAD_MAINNET_UNISWAP_QUOTER || "0x661e93cca42afacb172121ef892830ca3b70f08d") as Address,
  wmon: (process.env.MONAD_MAINNET_WMON || "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A") as Address,
} as const;

/** Uniswap v3 standard fee tiers — quoted in parallel; the best output wins. */
const FEE_TIERS = [500, 3000, 10000] as const;

/** SwapRouter02 recipient sentinel: address(2) = "this router contract". */
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable", // callable via eth_call; reverts are caught per-tier
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "fee", type: "uint24" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const SWAP_ROUTER_ABI = [
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
  {
    type: "function",
    name: "unwrapWETH9",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

/** Exported so other providers behind the same seam (e.g. kuruSwap.ts) reuse
 *  this instead of redefining the same two standard ERC-20 functions. */
export const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export interface SwapQuote {
  fromToken: SwapToken;
  toToken: SwapToken;
  amountIn: number;
  /** Best expected output across fee tiers (human units). */
  amountOut: number;
  /** Minimum out after slippage — what the swap tx enforces on-chain. */
  minAmountOut: number;
  /** Pool fee tier (bps) the best route used, e.g. 3000 = 0.3%. */
  feeTier: number;
  slippage: number;
  /** Indicative price: toToken per 1 fromToken. */
  rate: number;
  /** Estimated fraction (0..1) by which the trade's own size moves the pool
   *  price. null when it couldn't be estimated (see estimatePriceImpact()).
   *  A quote is never returned above MAX_PRICE_IMPACT -- rawQuote() throws
   *  instead -- so this is always a value that was allowed through. */
  priceImpact: number | null;
}

export interface UnsignedStep {
  kind: "approve" | "swap";
  label: string;
  tx: { to: Address; data: `0x${string}`; value: string };
}

export interface SwapPlan {
  quote: SwapQuote;
  steps: UnsignedStep[];
  summary: string;
  /** Which real provider this plan actually executes through ("Uniswap v3",
   *  "Kuru") — set by the aggregating getSwapProvider() below so callers can
   *  report the real route without asking a shared/mutable provider object
   *  which one won (unsafe under concurrent requests). Individual providers
   *  leave this unset; only the aggregator fills it in. */
  provider?: string;
}

export interface SwapProvider {
  readonly name: string;
  isConfigured(): boolean;
  quote(fromToken: SwapToken, toToken: SwapToken, amountIn: number): Promise<SwapQuote>;
  buildPlan(fromToken: SwapToken, toToken: SwapToken, amountIn: number, wallet: Address, slippage?: number): Promise<SwapPlan>;
}

/** A swap side, fully resolved: what to route through, how to scale it, and
 *  whether it is the chain's native asset (which decides wrap/unwrap). */
export interface ResolvedSwapSide {
  symbol: string;
  /** The address Uniswap routes through — WMON for native MON. */
  routeAddress: Address;
  decimals: number;
  isNative: boolean;
}

/**
 * Resolve a swap side from a token symbol against the same on-chain registry
 * the rest of the app uses, so a swap is no longer limited to MON/USDC while
 * every other surface (automations, bulk, the token selector) accepts any
 * fungible Monad token.
 *
 * MON resolves to WMON for routing but is flagged native, because Uniswap
 * always trades the wrapped form — the router wraps on the way in and unwraps
 * on the way out.
 */
export async function resolveSwapSide(symbol: string): Promise<ResolvedSwapSide> {
  const sym = symbol.trim().toUpperCase();
  if (sym === "MON") {
    return { symbol: "MON", routeAddress: UNISWAP_MAINNET.wmon, decimals: 18, isNative: true };
  }
  const match = (await getVerifiedTokens()).find((t) => t.symbol.toUpperCase() === sym && !/^0x0+$/.test(t.address));
  if (!match) {
    throw new Error(`${sym} isn't a token PayAI can swap yet. Try MON, USDC, USDT0, AUSD, WETH, or WBTC.`);
  }
  return { symbol: match.symbol, routeAddress: match.address as Address, decimals: match.decimals, isNative: false };
}

/** BigInt-exact result of quoting every fee tier and picking the best route,
 *  computed ONCE and shared by quote() and buildPlan() so the value that
 *  actually reaches on-chain calldata is never reconstructed by round-
 *  tripping through a lossy floating-point Number. */
interface RawQuote {
  inSide: ResolvedSwapSide;
  outSide: ResolvedSwapSide;
  amountInWei: bigint;
  fee: number;
  amountOutWei: bigint;
  /** Minimum out after slippage, in base units — what the swap tx enforces
   *  on-chain. Never zero for a positive `amountOutWei` (see minOutWei()). */
  minOutWei: bigint;
  /** Estimated fraction (0..1) by which the trade's OWN size moves the pool
   *  price, distinct from slippage. null when it couldn't be estimated
   *  (e.g. the trade is already too small to have a smaller reference). */
  priceImpact: number | null;
}

/** Never let a positive output quote floor to a zero enforced minimum --
 *  that would sign a swap with no real slippage protection at all. */
function minOutWei(amountOutWei: bigint, slippage: number): bigint {
  const bps = BigInt(Math.round((1 - slippage) * 1_000_000));
  const floored = (amountOutWei * bps) / 1_000_000n;
  return floored === 0n && amountOutWei > 0n ? 1n : floored;
}

/**
 * Estimate how much the trade's own size moves the pool price, as distinct
 * from slippage (which protects against price moving BETWEEN quote and
 * execution). Quotes a much smaller reference amount at the SAME fee tier,
 * scales its rate up to the actual trade's size, and compares the shortfall
 * against what actually came back.
 *
 * Best-effort only: this is a secondary defense-in-depth check on top of the
 * primary protection (a correctly bounded, always-positive amountOutMinimum
 * -- see minOutWei()). If the reference quote itself fails for any reason,
 * this fails open (returns null) rather than blocking a trade over an
 * unrelated RPC hiccup.
 */
export async function estimatePriceImpact(
  pub: ReturnType<typeof getPublicClient>,
  tokenIn: Address, tokenOut: Address, fee: number,
  amountInWei: bigint, actualAmountOutWei: bigint,
): Promise<number | null> {
  if (amountInWei <= 1000n) return null; // too small to get a meaningfully smaller reference
  const referenceAmountInWei = amountInWei / 1000n;
  try {
    const { result } = await pub.simulateContract({
      address: UNISWAP_MAINNET.quoterV2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn: referenceAmountInWei, fee, sqrtPriceLimitX96: 0n }],
    });
    const referenceAmountOutWei = (result as readonly bigint[])[0];
    if (referenceAmountOutWei === 0n) return null;
    const expectedAtActualSize = (referenceAmountOutWei * amountInWei) / referenceAmountInWei;
    if (expectedAtActualSize === 0n) return null;
    const shortfall = expectedAtActualSize > actualAmountOutWei ? expectedAtActualSize - actualAmountOutWei : 0n;
    return Number(shortfall) / Number(expectedAtActualSize);
  } catch {
    return null;
  }
}

async function rawQuote(fromToken: SwapToken, toToken: SwapToken, amountIn: number, slippage: number): Promise<RawQuote> {
  if (fromToken === toToken) throw new Error("Choose two different tokens to swap.");
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > MAX_SLIPPAGE) {
    throw new Error(`Slippage tolerance must be between 0% and ${(MAX_SLIPPAGE * 100).toFixed(0)}%.`);
  }
  const pub = getPublicClient();
  // Registry-resolved, so quoting works for any verified token pair. The two
  // sides don't depend on each other, so resolve them concurrently rather
  // than paying two sequential RPC round-trips.
  const [inSide, outSide] = await Promise.all([resolveSwapSide(fromToken), resolveSwapSide(toToken)]);
  const tokenIn = inSide.routeAddress;
  const tokenOut = outSide.routeAddress;
  const amountInWei = parseUnits(String(amountIn), inSide.decimals);

  // Quote every fee tier in parallel; pools that don't exist revert and are
  // simply skipped. The tier with the largest output is the real best route.
  const results = await Promise.allSettled(
    FEE_TIERS.map(async (fee) => {
      const { result } = await pub.simulateContract({
        address: UNISWAP_MAINNET.quoterV2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0n }],
      });
      return { fee, amountOut: (result as readonly bigint[])[0] };
    }),
  );

  let best: { fee: number; amountOut: bigint } | null = null;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.amountOut > 0n) {
      if (!best || r.value.amountOut > best.amountOut) best = r.value;
    }
  }
  if (!best) {
    throw new Error(`No liquidity pool found for ${fromToken} → ${toToken} on Monad. This pair may not be tradable yet.`);
  }

  const priceImpact = await estimatePriceImpact(pub, tokenIn, tokenOut, best.fee, amountInWei, best.amountOut);
  if (priceImpact !== null && priceImpact > MAX_PRICE_IMPACT) {
    throw new Error(
      `This trade would move the pool price by an estimated ${(priceImpact * 100).toFixed(1)}%, ` +
      `which is too high to execute safely. Try a smaller amount.`,
    );
  }

  return {
    inSide, outSide, amountInWei,
    fee: best.fee,
    amountOutWei: best.amountOut,
    minOutWei: minOutWei(best.amountOut, slippage),
    priceImpact,
  };
}

const uniswapV3Provider: SwapProvider = {
  name: "Uniswap v3",

  isConfigured() {
    // Mainnet-only, and the swapped stablecoin must be configured.
    return getNetwork() === "mainnet" && getStablecoin().address !== "0x0000000000000000000000000000000000000000";
  },

  async quote(fromToken, toToken, amountIn) {
    const q = await rawQuote(fromToken, toToken, amountIn, DEFAULT_SLIPPAGE);
    const outDecimals = q.outSide.decimals;
    const amountOut = Number(formatUnits(q.amountOutWei, outDecimals));
    return {
      fromToken, toToken, amountIn,
      amountOut,
      minAmountOut: Number(formatUnits(q.minOutWei, outDecimals)),
      feeTier: q.fee,
      slippage: DEFAULT_SLIPPAGE,
      rate: amountOut / amountIn,
      priceImpact: q.priceImpact,
    };
  },

  async buildPlan(fromToken, toToken, amountIn, wallet, slippage = DEFAULT_SLIPPAGE) {
    // Quoted directly at the caller's own slippage and used as-is below --
    // NOT derived from quote()'s DEFAULT_SLIPPAGE-based display figures, and
    // NOT reconstructed from a human-readable Number, so the on-chain
    // amountOutMinimum is exactly what was computed, never a lossy round-trip
    // or a value that silently ignored a custom slippage argument.
    const raw = await rawQuote(fromToken, toToken, amountIn, slippage);
    const { inSide, outSide, amountInWei } = raw;
    const outDecimals = outSide.decimals;
    const amountOut = Number(formatUnits(raw.amountOutWei, outDecimals));
    const q: SwapQuote = {
      fromToken, toToken, amountIn,
      amountOut,
      minAmountOut: Number(formatUnits(raw.minOutWei, outDecimals)),
      feeTier: raw.fee,
      slippage,
      rate: amountOut / amountIn,
      priceImpact: raw.priceImpact,
    };
    const pub = getPublicClient();
    const router = UNISWAP_MAINNET.swapRouter02;
    const tokenIn = inSide.routeAddress;
    const tokenOut = outSide.routeAddress;
    const minOutWeiValue = raw.minOutWei;
    const steps: UnsignedStep[] = [];

    // An ERC-20 input must be pulled by the router, so it needs an allowance
    // first. A native input needs none — it arrives as msg.value.
    if (!inSide.isNative) {
      const allowance = (await pub.readContract({
        address: tokenIn, abi: ERC20_ABI, functionName: "allowance", args: [wallet, router],
      })) as bigint;
      if (allowance < amountInWei) {
        steps.push({
          kind: "approve",
          label: `Approve ${amountIn} ${inSide.symbol} for the swap`,
          tx: {
            to: tokenIn,
            data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [router, amountInWei] }),
            value: "0x0",
          },
        });
      }
    }

    const swapLabel = `Swap ${amountIn} ${inSide.symbol} for ${outSide.symbol}`;

    if (outSide.isNative) {
      // Native OUT: Uniswap can only deliver WMON, so the swap sends it to the
      // router (ADDRESS_THIS) and unwrapWETH9 forwards real MON to the user —
      // atomically in one multicall, so a failed unwrap reverts the swap too
      // and the user is never left holding WMON they didn't ask for.
      const swapCall = encodeFunctionData({
        abi: SWAP_ROUTER_ABI, functionName: "exactInputSingle",
        args: [{ tokenIn, tokenOut, fee: q.feeTier, recipient: ADDRESS_THIS, amountIn: amountInWei, amountOutMinimum: minOutWeiValue, sqrtPriceLimitX96: 0n }],
      });
      const unwrapCall = encodeFunctionData({
        abi: SWAP_ROUTER_ABI, functionName: "unwrapWETH9", args: [minOutWeiValue, wallet],
      });
      steps.push({
        kind: "swap",
        label: swapLabel,
        tx: {
          to: router,
          data: encodeFunctionData({ abi: SWAP_ROUTER_ABI, functionName: "multicall", args: [[swapCall, unwrapCall]] }),
          // Native IN and native OUT can't both apply (from === to is rejected).
          value: inSide.isNative ? `0x${amountInWei.toString(16)}` : "0x0",
        },
      });
    } else {
      // ERC-20 out — the token goes straight to the user, and crucially NO
      // unwrap step. The previous code unwrapped on every non-MON input, which
      // was only correct because the pair was hardcoded to MON/USDC; applied to
      // an ERC-20 → ERC-20 swap it would have tried to unwrap a token that
      // isn't WMON. `value` carries the input only when it is native MON.
      steps.push({
        kind: "swap",
        label: swapLabel,
        tx: {
          to: router,
          data: encodeFunctionData({
            abi: SWAP_ROUTER_ABI, functionName: "exactInputSingle",
            args: [{ tokenIn, tokenOut, fee: q.feeTier, recipient: wallet, amountIn: amountInWei, amountOutMinimum: minOutWeiValue, sqrtPriceLimitX96: 0n }],
          }),
          value: inSide.isNative ? `0x${amountInWei.toString(16)}` : "0x0",
        },
      });
    }

    return {
      quote: q,
      steps,
      summary: `Swap ${amountIn} ${fromToken} → ${q.amountOut.toFixed(toToken === "USDC" ? 2 : 4)} ${toToken}`,
    };
  },
};

/** Every provider behind the seam, loaded lazily (dynamic import, matching
 *  this codebase's existing convention for cross-module lazy loading) to
 *  avoid a static circular import with kuruSwap.ts, which itself imports
 *  shared helpers back from this file. */
export async function candidateProviders(): Promise<SwapProvider[]> {
  const { default: kuruProvider } = await import("./kuruSwap");
  return [uniswapV3Provider, kuruProvider].filter((p) => p.isConfigured());
}

/** Quotes every configured provider that can serve this pair CONCURRENTLY
 *  and returns whichever gives the better real output — a user waiting on
 *  a swap preview waits for the SLOWEST provider, not the sum of all of
 *  them. A provider throwing (pair it doesn't cover, no liquidity, an RPC
 *  hiccup) just excludes that one candidate — it only surfaces as an error
 *  if EVERY provider failed. */
export async function bestQuote(fromToken: SwapToken, toToken: SwapToken, amountIn: number): Promise<{ provider: SwapProvider; quote: SwapQuote }> {
  const providers = await candidateProviders();
  const settled = await Promise.allSettled(
    providers.map(async (provider) => ({ provider, quote: await provider.quote(fromToken, toToken, amountIn) })),
  );
  const ok: { provider: SwapProvider; quote: SwapQuote }[] = [];
  const failures: unknown[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") ok.push(r.value);
    else failures.push(r.reason);
  }
  if (ok.length === 0) {
    // Providers are tried in coverage order (Uniswap first — broader pair
    // support), so the first failure is usually the most informative one
    // (e.g. "No liquidity pool found for X → Y") rather than a narrower
    // "Kuru doesn't support this pair" masking the real reason.
    const first = failures[0];
    throw first instanceof Error ? first : new Error("No swap route available for this pair.");
  }
  return ok.reduce((best, cur) => (cur.quote.amountOut > best.quote.amountOut ? cur : best));
}

/**
 * The active swap provider — an aggregator across every real provider
 * behind the seam above (currently Uniswap v3 and Kuru), always routing
 * through whichever gives the better real output for THIS specific
 * request. Quote and execution always use the SAME provider (buildPlan()
 * re-resolves the winner itself rather than trusting a separately-computed
 * quote), so what's shown in the preview is exactly what gets signed.
 */
export function getSwapProvider(): SwapProvider {
  return {
    name: "PayAI",
    isConfigured() {
      // A coarse "is swapping possible on this network at all" gate, not
      // "is any ONE provider ready" -- Uniswap's own isConfigured() also
      // requires a configured stablecoin, which would wrongly report the
      // whole aggregator unavailable even for a pair (e.g. MON/AUSD) only
      // Kuru serves. Per-pair/per-provider readiness is already handled by
      // bestQuote()'s fallback below; this only needs to agree with what
      // every provider behind the seam requires in common.
      return getNetwork() === "mainnet";
    },
    async quote(fromToken, toToken, amountIn) {
      const { quote } = await bestQuote(fromToken, toToken, amountIn);
      return quote;
    },
    async buildPlan(fromToken, toToken, amountIn, wallet, slippage) {
      const { provider } = await bestQuote(fromToken, toToken, amountIn);
      const plan = await provider.buildPlan(fromToken, toToken, amountIn, wallet, slippage);
      return { ...plan, provider: provider.name };
    },
  };
}
