/**
 * Token Intelligence — identify an arbitrary Monad address and report real,
 * on-chain-verified data about it. This is the READ-ONLY layer behind Ask
 * PayAI's "what is this token? 0x..." capability: it never builds a
 * transaction, never signs, never touches a wallet's funds. See
 * lib/ask/intent/orchestrate.ts's dispatchTokenLookup for the only caller.
 *
 * Reuses the same infrastructure the rest of the app already trusts:
 *  - lib/monad/tokenRegistry's resolveToken() for ERC-20 detection + metadata
 *    (its own Promise.all symbol/name/decimals read IS the "does this behave
 *    like an ERC-20" check — a throw there means "no").
 *  - lib/monad/swap's bestQuote()/getStablecoin() for pricing a VERIFIED
 *    token (safe to do — resolveToken()'s `verified` flag is only true when
 *    the address is byte-exact in the curated registry, so there's no risk
 *    of quoting a different contract that happens to share a symbol).
 *  - A direct, address-based Uniswap QuoterV2 probe (new, minimal, additive)
 *    for an UNVERIFIED/arbitrary token, which bestQuote() can't reach at all
 *    since it resolves by curated symbol, not raw address. This is the
 *    general case this feature exists for.
 *
 * Server-only.
 */
import "server-only";
import { formatUnits, parseUnits, type Address } from "viem";
import { getPublicClient } from "./wallet";
import { getNetwork, getStablecoin, explorerAddress } from "./config";
import { resolveToken, type TokenInfo } from "./tokenRegistry";
import { bestQuote, resolveSwapSide } from "./swap";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Minimal reads not already covered by resolveToken()'s symbol/name/decimals. */
const TOKEN_EXTRA_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Same Uniswap v3 QuoterV2 swap.ts already trusts (Monad mainnet, chain 143)
 *  — duplicated narrowly rather than exported, since this probe is
 *  deliberately address-based (bypasses resolveSwapSide's curated-symbol
 *  lookup entirely) while swap.ts's own copy stays symbol-based. */
const UNISWAP_QUOTER = (process.env.MONAD_MAINNET_UNISWAP_QUOTER || "0x661e93cca42afacb172121ef892830ca3b70f08d") as Address;
const FEE_TIERS = [500, 3000, 10000] as const;
const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
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

export interface TokenMarketPair {
  dex: string;
  base: string;
  quote: string;
}

/** Every field here is either a real, freshly-read value or explicitly
 *  `null` — never a fabricated 0 or "$0.00". liquidity/volume24h/
 *  priceChange24h are always null today: no indexer/subgraph is wired into
 *  this app, and an honest "unavailable" beats a made-up number. */
export interface TokenMarketData {
  price: string | null;
  priceQuoteAsset: string | null;
  liquidity: string | null;
  volume24h: string | null;
  priceChange24h: string | null;
  pairs: TokenMarketPair[];
}

export interface TokenIntelligence {
  isToken: true;
  isTradable: boolean;
  chain: "Monad";
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string | null;
  verified: boolean;
  userBalance: string | null;
  explorerUrl: string;
  market: TokenMarketData;
}

export type TokenInspection =
  | { kind: "invalid"; reason: string }
  | { kind: "wallet" }
  | { kind: "unknown_contract" }
  | { kind: "token"; data: TokenIntelligence };

async function readTotalSupply(pub: ReturnType<typeof getPublicClient>, address: Address, decimals: number): Promise<string | null> {
  try {
    const raw = (await pub.readContract({ address, abi: TOKEN_EXTRA_ABI, functionName: "totalSupply" })) as bigint;
    return formatUnits(raw, decimals);
  } catch {
    return null;
  }
}

async function readBalance(pub: ReturnType<typeof getPublicClient>, address: Address, owner: Address, decimals: number): Promise<string | null> {
  try {
    const raw = (await pub.readContract({ address, abi: TOKEN_EXTRA_ABI, functionName: "balanceOf", args: [owner] })) as bigint;
    return formatUnits(raw, decimals);
  } catch {
    return null;
  }
}

/** General, address-based tradability/price probe against Uniswap only —
 *  works for ANY token (curated or not) because it never goes through
 *  symbol resolution. Mirrors swap.ts's rawQuote() fee-tier loop, just
 *  parameterized on raw addresses. Returns null (never 0) when no fee tier
 *  has a real pool. */
async function probeUniswapDirect(tokenIn: Address, tokenInDecimals: number, tokenOut: Address, tokenOutDecimals: number): Promise<number | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  const amountIn = parseUnits("1", tokenInDecimals);
  const results = await Promise.allSettled(
    FEE_TIERS.map(async (fee) => {
      const { result } = await pub.simulateContract({
        address: UNISWAP_QUOTER, abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      });
      return (result as readonly bigint[])[0];
    }),
  );
  let best: bigint | null = null;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value > 0n && (best === null || r.value > best)) best = r.value;
  }
  return best !== null ? Number(formatUnits(best, tokenOutDecimals)) : null;
}

/** Prices the token against a stablecoin (or MON, if the token itself IS the
 *  stablecoin) and reports every DEX that actually served a route.
 *
 *  Verified tokens go through the SAME aggregator (Uniswap + Kuru) the real
 *  swap engine uses — safe because `verified` only means "byte-exact match
 *  in the curated registry", so there's no same-symbol-different-contract
 *  risk. Unverified/arbitrary tokens only get the direct Uniswap probe —
 *  Kuru's own market list (see kuruSwap.ts's KURU_MARKETS) is small and
 *  curated-symbol-keyed, so it isn't reachable for a token PayAI doesn't
 *  already know; that's an honest gap, not a fabricated result. */
async function probeMarket(info: TokenInfo, address: Address): Promise<TokenMarketData> {
  const pairs: TokenMarketPair[] = [];
  let price: string | null = null;
  const stablecoin = getStablecoin();
  const isStablecoinItself = address.toLowerCase() === stablecoin.address.toLowerCase();
  const quoteSymbol = isStablecoinItself ? "MON" : stablecoin.symbol;

  if (info.verified) {
    try {
      const { provider, quote } = await bestQuote(info.symbol, quoteSymbol, 1);
      price = String(quote.amountOut);
      pairs.push({ dex: provider.name, base: info.symbol, quote: quoteSymbol });
    } catch {
      /* no route via the aggregator for this pair -- fall through below */
    }
  }

  if (pairs.length === 0) {
    try {
      const quoteSide = await resolveSwapSide(quoteSymbol);
      const out = await probeUniswapDirect(address, info.decimals, quoteSide.routeAddress, quoteSide.decimals);
      if (out !== null) {
        price = out.toFixed(8);
        pairs.push({ dex: "Uniswap v3", base: info.symbol, quote: quoteSymbol });
      }
    } catch {
      /* quote asset itself isn't resolvable (misconfigured stablecoin) -- no route */
    }
  }

  return {
    price,
    priceQuoteAsset: price != null ? quoteSymbol : null,
    liquidity: null,
    volume24h: null,
    priceChange24h: null,
    pairs,
  };
}

/**
 * The single entry point: identify `addressInput` and return everything
 * real that could be found about it. Never throws for a bad/unreachable
 * address — always resolves to a typed outcome; the caller (the API route)
 * still wraps this in its own try/catch for a genuine RPC/network failure.
 */
export async function inspectAddress(addressInput: string, walletAddress?: string | null): Promise<TokenInspection> {
  const address = addressInput.trim();
  if (!ADDR_RE.test(address)) return { kind: "invalid", reason: "not a valid EVM address" };
  if (getNetwork() !== "mainnet") return { kind: "invalid", reason: "token intelligence is only available on Monad mainnet" };

  const pub = getPublicClient();
  const code = await pub.getCode({ address: address as Address });
  if (!code || code === "0x") return { kind: "wallet" };

  let info: TokenInfo;
  try {
    info = await resolveToken(address);
  } catch {
    return { kind: "unknown_contract" };
  }

  const addr = address as Address;
  const [totalSupply, userBalance, market] = await Promise.all([
    readTotalSupply(pub, addr, info.decimals),
    walletAddress ? readBalance(pub, addr, walletAddress as Address, info.decimals) : Promise.resolve(null),
    probeMarket(info, addr),
  ]);

  return {
    kind: "token",
    data: {
      isToken: true,
      isTradable: market.pairs.length > 0,
      chain: "Monad",
      address,
      name: info.name,
      symbol: info.symbol,
      decimals: info.decimals,
      totalSupply,
      verified: info.verified,
      userBalance,
      explorerUrl: explorerAddress(address),
      market,
    },
  };
}
