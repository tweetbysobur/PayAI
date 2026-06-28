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

export type SwapToken = "MON" | "USDC";

/** Default slippage tolerance (0.5%) — overridable per request. */
export const DEFAULT_SLIPPAGE = 0.005;

/** Native MON is 18 decimals; USDC is read from config (6). */
function tokenDecimals(token: SwapToken): number {
  return token === "MON" ? 18 : getStablecoin().decimals;
}

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

/** Resolve a swap token to the ERC-20 it trades as (MON trades as WMON). */
function tokenAddress(token: SwapToken): Address {
  return token === "MON" ? UNISWAP_MAINNET.wmon : getStablecoin().address;
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
    const tokenIn = tokenAddress(fromToken);
    const tokenOut = tokenAddress(toToken);
    const amountInWei = parseUnits(String(amountIn), tokenDecimals(fromToken));

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

    const outDecimals = tokenDecimals(toToken);
    const amountOut = Number(formatUnits(best.amountOut, outDecimals));
    const minOutWei = (best.amountOut * BigInt(Math.round((1 - DEFAULT_SLIPPAGE) * 1e6))) / 1_000_000n;
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
    const tokenIn = tokenAddress(fromToken);
    const tokenOut = tokenAddress(toToken);
    const amountInWei = parseUnits(String(amountIn), tokenDecimals(fromToken));
    const minOutWei = parseUnits(q.minAmountOut.toFixed(tokenDecimals(toToken)), tokenDecimals(toToken));
    const steps: UnsignedStep[] = [];

    if (fromToken === "MON") {
      // Native MON in: the router wraps msg.value, so a single exactInputSingle
      // with value = amountIn and recipient = the user. No approval needed.
      const data = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{ tokenIn, tokenOut, fee: q.feeTier, recipient: wallet, amountIn: amountInWei, amountOutMinimum: minOutWei, sqrtPriceLimitX96: 0n }],
      });
      steps.push({
        kind: "swap",
        label: `Swap ${amountIn} MON for USDC`,
        tx: { to: router, data, value: `0x${amountInWei.toString(16)}` },
      });
    } else {
      // ERC-20 (USDC) in, native MON out. First ensure the router is approved
      // to pull the USDC; then multicall [swap into the router, unwrap to MON].
      const allowance = (await pub.readContract({
        address: tokenIn, abi: ERC20_ABI, functionName: "allowance", args: [wallet, router],
      })) as bigint;
      if (allowance < amountInWei) {
        const approveData = encodeFunctionData({
          abi: ERC20_ABI, functionName: "approve", args: [router, amountInWei],
        });
        steps.push({
          kind: "approve",
          label: `Approve ${amountIn} USDC for the swap`,
          tx: { to: tokenIn, data: approveData, value: "0x0" },
        });
      }
      // Swap USDC -> WMON with the router itself as recipient, then unwrap the
      // WMON to native MON and send it to the user — atomically via multicall.
      const swapCall = encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{ tokenIn, tokenOut, fee: q.feeTier, recipient: ADDRESS_THIS, amountIn: amountInWei, amountOutMinimum: minOutWei, sqrtPriceLimitX96: 0n }],
      });
      const unwrapCall = encodeFunctionData({
        abi: SWAP_ROUTER_ABI, functionName: "unwrapWETH9", args: [minOutWei, wallet],
      });
      const multicallData = encodeFunctionData({
        abi: SWAP_ROUTER_ABI, functionName: "multicall", args: [[swapCall, unwrapCall]],
      });
      steps.push({
        kind: "swap",
        label: `Swap ${amountIn} USDC for MON`,
        tx: { to: router, data: multicallData, value: "0x0" },
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
