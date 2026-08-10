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

/** A token SYMBOL. Any verified Monad token, resolved via resolveSwapSide()
 *  against the on-chain registry — no longer a two-token union. */
export type SwapToken = string;

/** Default slippage tolerance (0.5%) — overridable per request. */
export const DEFAULT_SLIPPAGE = 0.005;

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

const ERC20_ABI = [
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
  const { getVerifiedTokens } = await import("./tokenRegistry");
  const match = (await getVerifiedTokens()).find((t) => t.symbol.toUpperCase() === sym && !/^0x0+$/.test(t.address));
  if (!match) {
    throw new Error(`${sym} isn't a token PayAI can swap yet. Try MON, USDC, USDT0, AUSD, WETH, or WBTC.`);
  }
  return { symbol: match.symbol, routeAddress: match.address as Address, decimals: match.decimals, isNative: false };
}

const uniswapV3Provider: SwapProvider = {
  name: "Uniswap v3",

  isConfigured() {
    // Mainnet-only, and the swapped stablecoin must be configured.
    return getNetwork() === "mainnet" && getStablecoin().address !== "0x0000000000000000000000000000000000000000";
  },

  async quote(fromToken, toToken, amountIn) {
    if (fromToken === toToken) throw new Error("Choose two different tokens to swap.");
    const pub = getPublicClient();
    // Registry-resolved, so quoting works for any verified token pair.
    const inSide = await resolveSwapSide(fromToken);
    const outSide = await resolveSwapSide(toToken);
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

    const outDecimals = outSide.decimals;
    const amountOut = Number(formatUnits(best.amountOut, outDecimals));
    // Integer division floors a positive dust quote (e.g. 1 base unit) to a
    // zero minimum, which would let a signed swap execute with no enforced
    // floor at all. Never let a positive quote produce a zero minOut.
    let minOutWei = (best.amountOut * BigInt(Math.round((1 - DEFAULT_SLIPPAGE) * 1e6))) / 1_000_000n;
    if (minOutWei === 0n && best.amountOut > 0n) minOutWei = 1n;
    return {
      fromToken, toToken, amountIn,
      amountOut,
      minAmountOut: Number(formatUnits(minOutWei, outDecimals)),
      feeTier: best.fee,
      slippage: DEFAULT_SLIPPAGE,
      rate: amountOut / amountIn,
    };
  },

  async buildPlan(fromToken, toToken, amountIn, wallet, slippage = DEFAULT_SLIPPAGE) {
    const q = await this.quote(fromToken, toToken, amountIn);
    const pub = getPublicClient();
    const router = UNISWAP_MAINNET.swapRouter02;
    // Resolve both sides against the token registry rather than assuming
    // MON/USDC, so any verified Monad token can be swapped.
    const inSide = await resolveSwapSide(fromToken);
    const outSide = await resolveSwapSide(toToken);
    const tokenIn = inSide.routeAddress;
    const tokenOut = outSide.routeAddress;
    const amountInWei = parseUnits(String(amountIn), inSide.decimals);
    const minOutWei = parseUnits(q.minAmountOut.toFixed(outSide.decimals), outSide.decimals);
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
        args: [{ tokenIn, tokenOut, fee: q.feeTier, recipient: ADDRESS_THIS, amountIn: amountInWei, amountOutMinimum: minOutWei, sqrtPriceLimitX96: 0n }],
      });
      const unwrapCall = encodeFunctionData({
        abi: SWAP_ROUTER_ABI, functionName: "unwrapWETH9", args: [minOutWei, wallet],
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
            args: [{ tokenIn, tokenOut, fee: q.feeTier, recipient: wallet, amountIn: amountInWei, amountOutMinimum: minOutWei, sqrtPriceLimitX96: 0n }],
          }),
          value: inSide.isNative ? `0x${amountInWei.toString(16)}` : "0x0",
        },
      });
    }

    return {
      quote: { ...q, slippage },
      steps,
      summary: `Swap ${amountIn} ${fromToken} → ${q.amountOut.toFixed(toToken === "USDC" ? 2 : 4)} ${toToken}`,
    };
  },
};

/** The active swap provider. Single seam for swapping in an aggregator later. */
export function getSwapProvider(): SwapProvider {
  return uniswapV3Provider;
}
