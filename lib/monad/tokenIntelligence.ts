/**
 * Token & Market Intelligence — identify an arbitrary Monad address and
 * report real, on-chain-verified data about it: what it is, what it's
 * worth, and how (if at all) it can actually be traded. This is the
 * READ-ONLY layer behind Ask PayAI's "what is this token? 0x..." and
 * "can I trade it with USDC?" capabilities — it never builds a
 * transaction, never signs, never touches a wallet's funds. See
 * lib/ask/intent/orchestrate.ts's dispatchTokenLookup for the only caller.
 *
 * Reuses the same infrastructure the rest of the app already trusts:
 *  - lib/monad/tokenRegistry's resolveToken() for ERC-20 detection + metadata
 *    (its own Promise.all symbol/name/decimals read IS the "does this behave
 *    like an ERC-20" check — a throw there means "no"). Its cache is
 *    permanent, which is correct: this metadata is immutable on-chain.
 *  - lib/monad/prices's getUsdPrice() for the headline USD figure — the
 *    SAME address-based, cached (60s TTL), shallow-pool-rejecting pricing
 *    the rest of the app already shows users, not a second, weaker
 *    implementation. This is also where "market data must stay fresh"
 *    without a new cache comes from: that TTL already exists and is reused
 *    as-is, nothing new added here.
 *  - lib/monad/swap's candidateProviders()/estimatePriceImpact
 *    for VERIFIED tokens (safe to route by symbol — resolveToken()'s
 *    `verified` flag is only true when the address is byte-exact in the
 *    curated registry, so there's no risk of quoting a different contract
 *    that happens to share a symbol).
 *  - A direct, address-based Uniswap QuoterV2 probe (matches this
 *    codebase's own established pattern — prices.ts does the same, for the
 *    same reason: an arbitrary/unverified token has no curated symbol to
 *    resolve by) for an UNVERIFIED token's per-pair routes, still reusing
 *    swap.ts's estimatePriceImpact() for the impact number rather than
 *    reimplementing that math a third time.
 *
 * Server-only.
 */
import "server-only";
import { formatUnits, parseUnits, type Address } from "viem";
import { getPublicClient } from "./wallet";
import { getNetwork, getStablecoin, explorerAddress } from "./config";
import { resolveToken, type TokenInfo } from "./tokenRegistry";
import { candidateProviders, estimatePriceImpact, MAX_PRICE_IMPACT, resolveSwapSide } from "./swap";
import { getUsdPrice } from "./prices";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Minimal reads not already covered by resolveToken()'s symbol/name/decimals. */
const TOKEN_EXTRA_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Same Uniswap v3 QuoterV2 swap.ts and prices.ts both already trust (Monad
 *  mainnet, chain 143) — duplicated narrowly rather than exported, matching
 *  prices.ts's own established precedent for this exact situation: an
 *  address-based probe needs its own small copy since swap.ts's version is
 *  symbol-based internally. */
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

/** The only two base pairs PayAI's own liquidity infrastructure actually
 *  covers today (Uniswap + Kuru both route through these). "TOKEN/WMON" from
 *  the spec collapses into "TOKEN/MON" here rather than being listed twice:
 *  Uniswap always trades the wrapped form under the hood (see swap.ts's
 *  resolveSwapSide — MON resolves to the same WMON pool either way), so a
 *  separate WMON line would just duplicate the MON row's exact data, not
 *  report a genuinely different route. */
const QUOTE_ASSETS = ["USDC", "MON"] as const;

export interface TokenRoute {
  provider: string;
  inputToken: string;
  outputToken: string;
  /** For 1 unit of inputToken, human-readable. */
  estimatedOutput: string;
  /** Formatted percentage ("1.23%"), or null when it couldn't be estimated
   *  (Kuru's own simulate call doesn't expose this — see kuruSwap.ts's own
   *  quote(), which already returns priceImpact: null for the same honest
   *  reason). Never a fabricated number. */
  priceImpact: string | null;
  /** Always true — a route that isn't usable is never added to the list in
   *  the first place (see the module doc's "only show a pair if a route
   *  exists"), so this field's only job is matching the spec's schema. */
  available: true;
}

/** A specific requested amount, quoted through whichever real route serves
 *  it — the discovery layer Step 3's execution will build on. `route: null`
 *  means no usable route existed for that pair, not that the number is 0. */
export interface QuotedAmount {
  amount: string;
  quoteAsset: string;
  route: TokenRoute | null;
}

/** Every field here is either a real, freshly-read value or explicitly
 *  `null` — never a fabricated 0 or "$0.00". `price` comes from
 *  lib/monad/prices's getUsdPrice(), which already refuses to price a pool
 *  too shallow to trust (returns null rather than a misleading number) —
 *  so a route can exist in `routes` while `price` is still null; that's not
 *  a bug, it's "a route was found, but it isn't liquid enough to price
 *  honestly," which the caller can and should show as such (see the spec's
 *  own "Liquidity data unavailable, but a trading route was found").
 *  liquidity/volume24h/priceChange24h are always null today: no
 *  indexer/subgraph is wired into this app (see this module's own
 *  investigation, documented in the Step 2 report, not restated in code). */
export interface TokenMarketData {
  price: string | null;
  priceQuoteAsset: string | null;
  liquidity: string | null;
  volume24h: string | null;
  priceChange24h: string | null;
  /** Which quote assets were actually probed — transparency about what
   *  "no pairs found" does and doesn't mean (e.g. AUSD was never checked). */
  quoteAssetsChecked: string[];
  routes: TokenRoute[];
  /** Descriptive tags only — never a verdict. See this module's doc and the
   *  Step 2 report for the exact list and what each one means. */
  signals: string[];
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
  /** Present only when a specific amount was actually requested (e.g. "how
   *  much would I get for 50?") — absent, not null, when nothing was asked. */
  quote?: QuotedAmount | null;
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

function fmtImpact(impact: number | null): string | null {
  return impact != null ? `${(impact * 100).toFixed(2)}%` : null;
}

/** General, address-based single-pair probe against Uniswap — works for ANY
 *  token (curated or not) because it never goes through symbol resolution.
 *  Mirrors swap.ts's rawQuote() fee-tier loop, then reuses swap.ts's own
 *  estimatePriceImpact() for the impact number rather than recomputing that
 *  math here too. Returns null (never a route with a fabricated 0 output)
 *  when no fee tier has a real pool. */
async function probeUniswapPair(
  tokenIn: Address, tokenInSymbol: string, tokenInDecimals: number,
  tokenOut: Address, tokenOutSymbol: string, tokenOutDecimals: number,
  amount: string,
): Promise<TokenRoute | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  const amountIn = parseUnits(amount, tokenInDecimals);
  const settled = await Promise.allSettled(
    FEE_TIERS.map(async (fee) => {
      const { result } = await pub.simulateContract({
        address: UNISWAP_QUOTER, abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      });
      return { fee, amountOut: (result as readonly bigint[])[0] };
    }),
  );
  let best: { fee: number; amountOut: bigint } | null = null;
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value.amountOut > 0n && (best === null || r.value.amountOut > best.amountOut)) best = r.value;
  }
  if (!best) return null;

  const impact = await estimatePriceImpact(pub, tokenIn, tokenOut, best.fee, amountIn, best.amountOut);
  return {
    provider: "Uniswap v3", inputToken: tokenInSymbol, outputToken: tokenOutSymbol,
    estimatedOutput: formatUnits(best.amountOut, tokenOutDecimals),
    priceImpact: fmtImpact(impact), available: true,
  };
}

/** Real trading-pair discovery for a VERIFIED token — safe to route by
 *  symbol (see this module's doc for why), and reuses candidateProviders()
 *  directly so EVERY configured provider that actually serves a pair shows
 *  up (not just the winner bestQuote() would pick), matching the spec's
 *  "identify where liquidity comes from". */
async function routesForVerifiedToken(info: TokenInfo, quoteAssets: readonly string[], amount: string): Promise<TokenRoute[]> {
  const providers = await candidateProviders();
  const attempts = await Promise.all(
    quoteAssets.flatMap((quoteAsset) =>
      providers.map(async (provider): Promise<TokenRoute | null> => {
        try {
          const quote = await provider.quote(info.symbol, quoteAsset, Number(amount));
          return {
            provider: provider.name, inputToken: info.symbol, outputToken: quoteAsset,
            estimatedOutput: String(quote.amountOut), priceImpact: fmtImpact(quote.priceImpact), available: true,
          };
        } catch {
          return null; // this provider doesn't serve this pair -- an honest gap, not an error
        }
      }),
    ),
  );
  return attempts.filter((r): r is TokenRoute => r !== null);
}

/** Same discovery, but address-based for a token with no curated symbol to
 *  safely route by — Uniswap only (Kuru's own market list is small and
 *  symbol-keyed against curated tokens; see this module's Step 2 report for
 *  why that's an honest, documented gap rather than something faked here). */
async function routesForArbitraryToken(
  address: Address, symbol: string, decimals: number, quoteAssets: readonly string[], amount: string,
): Promise<TokenRoute[]> {
  const attempts = await Promise.all(
    quoteAssets.map(async (quoteAsset): Promise<TokenRoute | null> => {
      try {
        const side = await resolveSwapSide(quoteAsset);
        return await probeUniswapPair(address, symbol, decimals, side.routeAddress, quoteAsset, side.decimals, amount);
      } catch {
        return null; // the quote asset itself isn't resolvable -- no route
      }
    }),
  );
  return attempts.filter((r): r is TokenRoute => r !== null);
}

/** Discovers real routes for `amount` of the token against every quote
 *  asset that applies (excluding the token pairing with itself), dispatched
 *  to the verified or arbitrary-token path per this module's own
 *  contract-address-is-truth rule. */
async function discoverRoutes(info: TokenInfo, address: Address, quoteAssets: readonly string[], amount: string): Promise<TokenRoute[]> {
  const stablecoin = getStablecoin();
  const candidates = quoteAssets.filter((qa) => {
    if (qa === "USDC" && address.toLowerCase() === stablecoin.address.toLowerCase()) return false;
    if (qa === "MON" && info.symbol.toUpperCase() === "MON") return false;
    return true;
  });
  if (candidates.length === 0) return [];
  return info.verified
    ? routesForVerifiedToken(info, candidates, amount)
    : routesForArbitraryToken(address, info.symbol, info.decimals, candidates, amount);
}

/** Descriptive tags only (never "scam"/"safe" — see this module's doc). */
function computeSignals(routes: TokenRoute[], usdPrice: number | null, quoteAssetsChecked: readonly string[]): string[] {
  const signals: string[] = [];
  if (routes.length === 0) {
    signals.push("no_liquidity");
    return signals; // the rest don't apply with nothing to measure
  }
  if (usdPrice === null) signals.push("quote_unavailable");
  const impacts = routes.map((r) => (r.priceImpact ? parseFloat(r.priceImpact) / 100 : null)).filter((n): n is number => n !== null);
  const worst = impacts.length > 0 ? Math.max(...impacts) : null;
  if (worst !== null) {
    if (worst > MAX_PRICE_IMPACT) signals.push("high_price_impact");
    else if (worst > MAX_PRICE_IMPACT / 3) signals.push("very_low_liquidity");
  }
  if (routes.length < quoteAssetsChecked.length) signals.push("unsupported_trading_pair");
  return signals;
}

async function probeMarket(info: TokenInfo, address: Address): Promise<TokenMarketData> {
  const stablecoin = getStablecoin();
  const quoteAssetsChecked = QUOTE_ASSETS.filter((qa) => {
    if (qa === "USDC" && address.toLowerCase() === stablecoin.address.toLowerCase()) return false;
    if (qa === "MON" && info.symbol.toUpperCase() === "MON") return false;
    return true;
  });

  const [routes, usdPrice] = await Promise.all([
    discoverRoutes(info, address, QUOTE_ASSETS, "1"),
    getUsdPrice(address, info.decimals),
  ]);

  return {
    price: usdPrice != null ? usdPrice.toFixed(usdPrice < 1 ? 8 : 4) : null,
    priceQuoteAsset: usdPrice != null ? "USD" : null,
    liquidity: null,
    volume24h: null,
    priceChange24h: null,
    quoteAssetsChecked,
    routes,
    signals: computeSignals(routes, usdPrice, quoteAssetsChecked),
  };
}

/**
 * The single entry point: identify `addressInput` and return everything
 * real that could be found about it. Never throws for a bad/unreachable
 * address — always resolves to a typed outcome; the caller (the API route)
 * still wraps this in its own try/catch for a genuine RPC/network failure.
 *
 * `quoteRequest`, when given, additionally prices a SPECIFIC amount against
 * a specific (or the best available) quote asset — the discovery layer for
 * "how much would I get for 50?", still never signing or executing anything.
 */
export async function inspectAddress(
  addressInput: string,
  walletAddress?: string | null,
  quoteRequest?: { amount: string; quoteAsset?: string | null } | null,
): Promise<TokenInspection> {
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

  let quote: QuotedAmount | null | undefined;
  if (quoteRequest?.amount) {
    const quoteAsset = quoteRequest.quoteAsset ?? market.routes[0]?.outputToken ?? QUOTE_ASSETS[0];
    const routes = await discoverRoutes(info, addr, [quoteAsset], quoteRequest.amount);
    quote = { amount: quoteRequest.amount, quoteAsset, route: routes[0] ?? null };
  }

  return {
    kind: "token",
    data: {
      isToken: true,
      isTradable: market.routes.length > 0,
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
      ...(quote !== undefined ? { quote } : {}),
    },
  };
}
