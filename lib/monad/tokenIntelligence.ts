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
 *    implementation.
 *  - lib/monad/swap's candidateProviders() for VERIFIED tokens (safe to
 *    route by symbol — resolveToken()'s `verified` flag is only true when
 *    the address is byte-exact in the curated registry, so there's no risk
 *    of quoting a different contract that happens to share a symbol).
 *  - lib/monad/swap's quoteUniswapDirect() for an UNVERIFIED token's
 *    per-pair routes — a general, address-based Uniswap probe shared with
 *    lib/monad/tradeQuote.ts (Step 3's trade quoting) so this fee-tier-loop-
 *    plus-price-impact logic lives in exactly one place, not two.
 *
 * Step 5 — external market-data provider: investigated DexScreener (this
 * app's previously identified candidate) plus CoinGecko/GeckoTerminal/
 * DefiLlama as alternatives. All four were UNREACHABLE from this
 * development/build environment — every outbound request to
 * api.dexscreener.com, docs.dexscreener.com, api.coingecko.com,
 * api.geckoterminal.com, and api.llama.fi was rejected by the sandbox's own
 * egress policy (403 policy denial at the network layer, confirmed via the
 * proxy's own status log — not a transient failure or a provider-side
 * block). That means the exact endpoint, response schema, rate limits, and
 * failure behavior could NOT be verified firsthand, so per this step's own
 * instruction ("do not guess any endpoint, do not invent an API response,
 * do not integrate a provider based only on search results") no external
 * provider is integrated. Market data stays exactly what Steps 1-2 already
 * built: real on-chain reads (price via prices.ts's DEX quote, routes via
 * candidateProviders()/quoteUniswapDirect()) — this already IS the
 * "external market data -> on-chain -> unavailable" fallback chain Step 5
 * asks for, just with the external leg absent rather than stubbed, so nulls
 * were never faked as zeros or invented as a fabricated provider response.
 * liquidity/volume24h/priceChange24h/pairAddress remain honestly
 * unavailable (null) for the same reason — an indexer/subgraph, not a
 * single-price DEX quote, is what would compute these, and no such source
 * could be verified either. If egress to a real provider is ever opened up,
 * `probeMarket` below is the one integration point.
 *
 * Server-only.
 */
import "server-only";
import { formatUnits, type Address } from "viem";
import { getPublicClient } from "./wallet";
import { getNetwork, getStablecoin, explorerAddress } from "./config";
import { resolveToken, type TokenInfo } from "./tokenRegistry";
import { candidateProviders, MAX_PRICE_IMPACT, quoteUniswapDirect, resolveSwapSide } from "./swap";
import { getUsdPrice } from "./prices";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Minimal reads not already covered by resolveToken()'s symbol/name/decimals. */
const TOKEN_EXTRA_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
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
  /** Date.now() when this market snapshot was actually fetched — may be
   *  served from the short-lived cache below, so this is NOT always "just
   *  now"; the UI uses it to show "updated Xs ago" rather than implying
   *  every render is a fresh RPC round-trip. Distinct from a trade quote's
   *  own quotedAt (lib/monad/tradeQuote.ts) — this is display-only market
   *  context and is never read by the execution/signing path. */
  lastUpdated: number;
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

/** Address-based single-pair probe against Uniswap — works for ANY token
 *  (curated or not) because it never goes through symbol resolution. Thin
 *  wrapper over swap.ts's quoteUniswapDirect(), which is also reused by
 *  lib/monad/tradeQuote.ts's trade quoting — the fee-tier-loop-plus-price-
 *  impact logic itself lives in exactly one place. */
async function probeUniswapPair(
  tokenIn: Address, tokenInSymbol: string, tokenInDecimals: number,
  tokenOut: Address, tokenOutSymbol: string, tokenOutDecimals: number,
  amount: string,
): Promise<TokenRoute | null> {
  const direct = await quoteUniswapDirect(tokenIn, tokenInDecimals, tokenOut, tokenOutDecimals, amount);
  if (!direct) return null;
  return { provider: "Uniswap v3", inputToken: tokenInSymbol, outputToken: tokenOutSymbol, estimatedOutput: direct.amountOut, priceImpact: direct.priceImpact, available: true };
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

/**
 * Market-data cache — separate from BOTH tokenRegistry's permanent metadata
 * cache (name/symbol/decimals never change) and prices.ts's own 60s price
 * cache (which this still calls through on every miss, so a market-data
 * cache hit still gets prices.ts's freshest cached price). This one caches
 * the more expensive part: route discovery, which fans out to every
 * provider x quote-asset combination and — unlike a single price quote —
 * had NO caching at all before Step 5, so "what's the price?" right after
 * pasting a contract address re-ran the full discovery fan-out twice in a
 * row for no reason. Short TTL (not the metadata cache's "permanent"):
 * routes and liquidity genuinely change, so this must expire, just not on
 * every single render. Never used by trade execution — previewTrade() and
 * prepareTradeExecution() in lib/monad/tradeQuote.ts call swap.ts's
 * bestQuote()/quoteUniswapDirect() directly and were never routed through
 * this cache, so Step 4's "always re-quote fresh before signing" guarantee
 * is untouched by this addition.
 */
const MARKET_TTL_MS = 20_000;
interface MarketCacheEntry { data: TokenMarketData; at: number }
const marketCache = new Map<string, MarketCacheEntry>();

/** Test-only escape hatch — a module-level cache otherwise persists across
 *  test cases that re-import this module (ESM caches by specifier), which
 *  would leak one test's mocked market snapshot into the next test run
 *  against the same address. Not called anywhere in application code. */
export function clearMarketDataCache(): void {
  marketCache.clear();
}

async function probeMarket(info: TokenInfo, address: Address): Promise<TokenMarketData> {
  const key = address.toLowerCase();
  const hit = marketCache.get(key);
  if (hit && Date.now() - hit.at < MARKET_TTL_MS) return hit.data;

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

  const data: TokenMarketData = {
    price: usdPrice != null ? usdPrice.toFixed(usdPrice < 1 ? 8 : 4) : null,
    priceQuoteAsset: usdPrice != null ? "USD" : null,
    liquidity: null,
    volume24h: null,
    priceChange24h: null,
    quoteAssetsChecked,
    routes,
    signals: computeSignals(routes, usdPrice, quoteAssetsChecked),
    lastUpdated: Date.now(),
  };
  marketCache.set(key, { data, at: Date.now() });
  return data;
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
