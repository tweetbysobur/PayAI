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
 * Step 5 (original) — external market-data provider: investigated
 * DexScreener plus CoinGecko/GeckoTerminal/DefiLlama as alternatives. All
 * four were UNREACHABLE from this development/build environment at the
 * time (403 policy denial at the sandbox's own egress layer), so per that
 * step's own instruction ("do not guess any endpoint... do not integrate a
 * provider based only on search results") none was integrated then.
 *
 * Later revisit: verified DexScreener's real public API against a working
 * open-source client's actual request code and response types (not search
 * results) — see lib/monad/dexscreener.ts's own doc for exactly what was
 * confirmed. volume24h/transactions24h/buys24h/sells24h/priceChange24h now
 * come from there, fed into `probeMarket` below (still the one integration
 * point).
 *
 * Liquidity later joined them, but only as a FALLBACK, not a second source
 * standing beside the first: whenever this app's own on-chain liquidity read
 * genuinely returns nothing, not whenever it merely disagrees with
 * DexScreener. On-chain always wins when it has an answer, so the two never
 * compete for the same token. This was previously an unconditional "never" —
 * two sources disagreeing on the same number would be confusing — but that
 * reasoning covered less than it looked like: this app has no on-chain
 * liquidity-depth read for an arbitrary Uniswap v3 pool at all (v3 is
 * concentrated liquidity, not simple x*y=k reserves), so EVERY Uniswap-only
 * token showed "Unavailable" for liquidity outright, and a GRADUATED Nad.Fun
 * token's on-chain read reverts too (verified live against BOB — see
 * probeMarket's own doc). Neither case has a real on-chain figure to
 * disagree with, so DexScreener's own indexed figure is what actually shows
 * now, clearly labeled, rather than a blank field next to a token the card
 * is already quoting a live price for.
 *
 * marketCapUsd/fdvUsd also gained a fallback for the identical reason: price
 * (and everything computed from it) previously came from Uniswap-v3-only
 * quoting, so any token with no USDC pool — most bonding-curve and freshly-
 * graduated Nad.Fun tokens — showed "Unavailable" for price, market cap AND
 * fdv together, despite the card already displaying a live MON-denominated
 * quote two rows away. See deriveUsdFromMon's own doc.
 *
 * buyVolume24h/sellVolume24h/holders remain honestly unavailable: DexScreener
 * reports total volume and transaction counts per window, not volume split
 * by side, and no holder-count source was found anywhere — splitting volume
 * by the buy/sell transaction ratio would be an invented approximation, not
 * a real number, so it stays null rather than guessed.
 *
 * Server-only.
 */
import "server-only";
import { formatUnits, type Address } from "viem";
import { getPublicClient } from "./wallet";
import { getNetwork, getStablecoin, explorerAddress } from "./config";
import { NATIVE_TOKEN_ADDRESS, resolveToken, type TokenInfo } from "./tokenRegistry";
import { candidateProviders, MAX_PRICE_IMPACT, quoteUniswapDirect, resolveSwapSide } from "./swap";
import {
  getNadFunCreatorInfo, getNadFunCurveReserves, getNadFunGraduatedPoolLiquidity, getNadFunProgress,
  getNadFunStatus, nadFunAvailableBuyTokens, nadFunQuote, type NadFunStatus, type NadFunStatusLabel,
} from "./nadfun";
import { getUsdPrice } from "./prices";
import { getDexScreenerSnapshot } from "./dexscreener";

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

/** Bonding-curve or graduated-DEX liquidity — Step 7's brief is explicit
 *  these are different concepts that must never be combined into one
 *  number or mislabeled as each other. `mon`/`usd` are the TOTAL value on
 *  both sides of the pool (2x one side, the standard TVL convention),
 *  never just the buy-capacity figure (see nadfun.ts's own
 *  availableBuyTokens doc for why that's a separate thing entirely). */
export interface TokenLiquidity {
  label: "Bonding Curve Liquidity" | "DEX Liquidity";
  mon: string;
  usd: string | null;
  /** The pool this was read from. Null for "Bonding Curve Liquidity" (the
   *  curve itself holds the reserves; there's no separate pool contract to
   *  name until graduation happens) or when the figure is DexScreener's
   *  fallback and its response didn't include one. Otherwise the graduated
   *  DEX pair's own address, from either source. */
  pool: string | null;
}

/** Every field here is either a real, freshly-read value or explicitly
 *  `null` — never a fabricated 0 or "$0.00". `price` comes from
 *  lib/monad/prices's getUsdPrice(), which already refuses to price a pool
 *  too shallow to trust (returns null rather than a misleading number) —
 *  so a route can exist in `routes` while `price` is still null; that's not
 *  a bug, it's "a route was found, but it isn't liquid enough to price
 *  honestly," which the caller can and should show as such (see the spec's
 *  own "Liquidity data unavailable, but a trading route was found").
 *
 *  marketCapUsd/fdvUsd (Step 7): both computed as `price × totalSupply` —
 *  the SAME formula, deliberately. This app has no verified source that
 *  distinguishes a Nad.Fun (or any arbitrary Monad) token's circulating
 *  supply from its total supply — no vesting/lock contract was found in
 *  the official Token.sol interface, and none is claimed anywhere reached
 *  during verification. Per the brief's own "if a reliable calculation
 *  cannot be established, return unavailable rather than inventing a
 *  value," these are reported as genuinely equal rather than fabricating
 *  an artificial difference between them; both are null together whenever
 *  price or totalSupply is unavailable. See the Step 7 report for the
 *  full reasoning.
 *
 *  24h fields, field by field — this list is what a UI can actually
 *  render, so it is kept exact rather than blanket-pessimistic (it used to
 *  say all of them were "always null today", which stopped being true once
 *  lib/monad/dexscreener.ts landed and would mislead anyone building
 *  against this type):
 *    - volume24h, transactions24h, buys24h, sells24h, priceChange24h —
 *      POPULATED from DexScreener when it has the token indexed; null when
 *      it doesn't (unreachable, not yet listed, malformed response). Null
 *      here means "not known", never "zero activity".
 *    - buyVolume24h, sellVolume24h — ALWAYS null. DexScreener reports 24h
 *      volume as ONE number and only splits the TRANSACTION COUNTS into
 *      buys/sells, so there is no verified source for the value split.
 *      Deriving it from the buy/sell count ratio would be fabrication, not
 *      an estimate: one $10k buy against a hundred $1 sells would report
 *      the split almost exactly backwards. Wiring these up needs a
 *      per-swap-event indexer that sums real amounts per side; the
 *      integration point is probeMarket() below, alongside the existing
 *      DexScreener call.
 *    - holders — ALWAYS null. Requires either a Transfer-event indexer or
 *      an explorer API; a live full-history Transfer scan is not viable
 *      (getNadFunCreatorInfo's own 5s timeout exists because even ONE
 *      topic-filtered historical getLogs took minutes against production
 *      RPC). Same integration point when a verified source exists. */
export interface TokenMarketData {
  price: string | null;
  priceQuoteAsset: string | null;
  /** Price in native MON per 1 token — reused directly from `routes`
   *  (whichever route quotes against MON) rather than a second RPC call. */
  priceMon: string | null;
  marketCapUsd: string | null;
  fdvUsd: string | null;
  liquidity: TokenLiquidity | null;
  volume24h: string | null;
  buyVolume24h: string | null;
  sellVolume24h: string | null;
  transactions24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  holders: number | null;
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

/** Nad.Fun status for a token, when the Lens recognizes it — see
 *  lib/monad/nadfun.ts's getNadFunStatus for exactly what each status means
 *  and how it's derived. `null` (not a "false" status) when this token isn't
 *  Nad.Fun-managed at all, so the UI can omit the whole section rather than
 *  show a status for a token that was never on Nad.Fun. */
export interface TokenNadFunInfo {
  status: NadFunStatusLabel;
  isLocked: boolean;
  /** Bonding-curve buy capacity, human units — only present pre-graduation
   *  (see nadFunAvailableBuyTokens's own doc for why it's null otherwise). */
  availableToBuy: string | null;
  /** 0-100, from the official Lens's getProgress() (bps / 100) — only
   *  meaningful pre-graduation, null otherwise. See getNadFunProgress's
   *  own doc for the one caveat on the bps-unit convention. */
  progressPct: number | null;
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
  nadFun: TokenNadFunInfo | null;
  /** Only populated for a Nad.Fun-recognized token, from its one
   *  `CurveCreate` log — see getNadFunCreatorInfo's own doc. Null for any
   *  other token: no reliable, verified general-purpose "who deployed
   *  this contract" source was found for an arbitrary Monad address. */
  creator: string | null;
  /** The relevant ACTIVE pool: the graduated DEX pair once one exists,
   *  otherwise the original bonding-curve pool — never an obsolete
   *  bonding-curve address shown after graduation (see the Step 7 brief's
   *  explicit warning). Null for a non-Nad.Fun token. */
  pool: string | null;
  /** Unix ms, from the Nad.Fun creation block's own timestamp. Null for a
   *  non-Nad.Fun token (no reliable general-purpose deployment-time source
   *  was found; see the Step 7 report). */
  createdAt: number | null;
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

/** Signed percentage display for a 24h price move, e.g. 0.0512 -> "+5.12%",
 *  -0.031 -> "-3.10%" — the sign itself is the whole point here (unlike
 *  fmtImpact above, always a magnitude), so toFixed's own minus sign is
 *  kept and a "+" is added for anything non-negative. */
function fmtSignedPct(fraction: number): string {
  const pct = fraction * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
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

/** Address-based probe against Nad.Fun (Step 6) — a bonding-curve token has
 *  no Uniswap pool at all until it graduates, so without this a perfectly
 *  tradable token would read as "no route found" against MON. Added
 *  alongside (never instead of) the Uniswap probe below, so a graduated
 *  token that trades on both shows both — the same "list every provider
 *  that actually serves this pair" principle routesForVerifiedToken already
 *  applies. `amount` here is 1 unit of the TOKEN, so this always quotes a
 *  SELL (token -> MON), matching what "how much is this worth" means for
 *  every other route in this list. */
async function probeNadFunAgainstMon(address: Address, symbol: string, decimals: number, amount: string): Promise<TokenRoute | null> {
  const q = await nadFunQuote(address, decimals, amount, false);
  if (!q) return null;
  return { provider: "Nad.Fun", inputToken: symbol, outputToken: "MON", estimatedOutput: q.amountOut, priceImpact: null, available: true };
}

/** Same discovery, but address-based for a token with no curated symbol to
 *  safely route by — Uniswap (any pair) plus Nad.Fun (MON pairs only; see
 *  probeNadFunAgainstMon) — Kuru's own market list is small and
 *  symbol-keyed against curated tokens; see this module's Step 2 report for
 *  why that's an honest, documented gap rather than something faked here). */
async function routesForArbitraryToken(
  address: Address, symbol: string, decimals: number, quoteAssets: readonly string[], amount: string,
): Promise<TokenRoute[]> {
  const attempts = await Promise.all(
    quoteAssets.flatMap((quoteAsset): Promise<TokenRoute | null>[] => {
      const uniswap = (async () => {
        try {
          const side = await resolveSwapSide(quoteAsset);
          return await probeUniswapPair(address, symbol, decimals, side.routeAddress, quoteAsset, side.decimals, amount);
        } catch {
          return null; // the quote asset itself isn't resolvable -- no route
        }
      })();
      if (quoteAsset.toUpperCase() !== "MON") return [uniswap];
      return [uniswap, probeNadFunAgainstMon(address, symbol, decimals, amount)];
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

/** Descriptive tags only (never "scam"/"safe" — see this module's doc).
 *  `liquidityKnown` disambiguates two genuinely different situations that
 *  both leave `routes` empty: a token this app has no liquidity signal for
 *  at all ("no_liquidity"), versus one it can independently confirm has
 *  real liquidity (a Nad.Fun on-chain read or DexScreener) despite no
 *  executable route being found through this app's own quoting — verified
 *  live against JAMES (0x43cF5407…d87777), a real ~$109k graduated pool
 *  whose Lens quote fails for a reason unrelated to this app. Reporting
 *  "no_liquidity" there would flatly contradict the Liquidity figure shown
 *  right above it on the same card. */
function computeSignals(routes: TokenRoute[], usdPrice: number | null, quoteAssetsChecked: readonly string[], liquidityKnown: boolean): string[] {
  const signals: string[] = [];
  if (routes.length === 0) {
    signals.push(liquidityKnown ? "no_route" : "no_liquidity");
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

/**
 * USD price for a token that has no USDC pool to quote against, derived from
 * the MON route it DOES have: (token → MON) × (MON → USD).
 *
 * getUsdPrice() prices strictly by quoting TOKEN → USDC on Uniswap v3. That is
 * the right primary source, but a bonding-curve or freshly-graduated Nad.Fun
 * token typically has no Uniswap/USDC pool at all — only a MON pair — so it
 * came back null. Because market cap and FDV are both price × totalSupply,
 * one missing price took the whole valuation block down with it: a token
 * showing a real, live MON quote and real DexScreener volume still rendered
 * "Price: Unavailable / Market Cap: Unavailable / FDV: Unavailable".
 *
 * Both inputs here are real, independently-sourced numbers this app already
 * trusts and already displays: the MON quote is the same route shown in the
 * card's own "Trading routes" row, and MON's own USD price comes from
 * getUsdPrice's normal Uniswap path (including its shallow-pool rejection, so
 * an untrustworthy MON price yields null here rather than propagating). This
 * is a unit conversion between two verified figures, not an estimate — and it
 * is only ever a FALLBACK: a direct USDC quote always wins when one exists.
 *
 * Still null-safe end to end: no MON route, or no trustworthy MON price, and
 * the field stays honestly unavailable exactly as before.
 */
function deriveUsdFromMon(priceMon: string | null, monUsdPrice: number | null): number | null {
  if (priceMon == null || monUsdPrice == null) return null;
  const perToken = Number(priceMon);
  if (!Number.isFinite(perToken) || perToken <= 0) return null;
  const usd = perToken * monUsdPrice;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/** price × totalSupply, formatted like the price field itself. Both
 *  marketCapUsd and fdvUsd use this SAME computation — see TokenMarketData's
 *  own doc for why they're deliberately equal rather than fabricating a
 *  circulating-vs-total distinction this app has no verified source for. */
function computeUsdValuation(usdPrice: number | null, totalSupply: string | null): string | null {
  if (usdPrice == null || totalSupply == null) return null;
  const supply = Number(totalSupply);
  if (!Number.isFinite(supply) || supply <= 0) return null;
  const value = usdPrice * supply;
  return value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 8 : 2 });
}

/** probeNadFunLiquidity's result: the liquidity figure shown on the card,
 *  plus a spot price derived from the SAME reserves that figure came from
 *  (never a second, independently-fetched number). Exists because the
 *  Lens's own getAmountOut can fail to quote a token this app otherwise
 *  fully recognizes and has real reserves for — verified live against
 *  JAMES (0x43cF5407…d87777): recognized, a real ~$109k graduated pool,
 *  yet `getAmountOut` reverts for a reason independent of this app's
 *  config. Rather than show "Price: Unavailable" next to a real, indexed
 *  pool, probeMarket falls back to pricing it directly off the reserves
 *  already fetched for the liquidity figure — the same x*y=k math the pool
 *  itself prices trades with. */
interface NadFunLiquidityProbe {
  liquidity: TokenLiquidity;
  /** MON per token, or null if a reserve was zero. Real reserves for a
   *  graduated pool; VIRTUAL reserves for a bonding-curve token, since those
   *  (not the "collected so far" real reserves) are what actually prices
   *  points on the curve. */
  priceMon: number | null;
}

/**
 * Bonding-curve or graduated-DEX liquidity for a Nad.Fun-recognized token —
 * a single direct read either way (curve reserves via `BondingCurve.curves`,
 * or the DEX pool's reserves via the factory + pair), never derived from
 * `availableBuyTokens` (a different concept — see TokenLiquidity's own doc)
 * and never combining the two sources into one number. Null for a token
 * Nad.Fun doesn't recognize: this app has no Uniswap-v3-compatible
 * liquidity-depth read (v3 is concentrated liquidity, not simple x*y=k
 * reserves), so an arbitrary Uniswap-routed token's liquidity stays
 * honestly unavailable in this pass — see the Step 7 report.
 */
async function probeNadFunLiquidity(
  address: Address, decimals: number, status: NadFunStatusLabel,
): Promise<NadFunLiquidityProbe | null> {
  if (status === "graduated") {
    const pool = await getNadFunGraduatedPoolLiquidity(address, decimals);
    if (!pool) return null;
    const monReserve = Number(pool.monReserve);
    const tokenReserve = Number(pool.tokenReserve);
    const monTotal = monReserve * 2;
    const monUsd = await getUsdPrice(NATIVE_TOKEN_ADDRESS, 18);
    return {
      liquidity: {
        label: "DEX Liquidity",
        mon: monTotal.toLocaleString(undefined, { maximumFractionDigits: 4 }),
        usd: monUsd != null ? (monTotal * monUsd).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null,
        pool: pool.pool,
      },
      priceMon: tokenReserve > 0 ? monReserve / tokenReserve : null,
    };
  }
  if (status === "bonding_curve" || status === "locked") {
    const reserves = await getNadFunCurveReserves(address, decimals);
    if (!reserves) return null;
    const monTotal = Number(reserves.realMon) * 2;
    const monUsd = await getUsdPrice(NATIVE_TOKEN_ADDRESS, 18);
    const virtualMon = Number(reserves.virtualMon);
    const virtualToken = Number(reserves.virtualToken);
    return {
      liquidity: {
        label: "Bonding Curve Liquidity",
        mon: monTotal.toLocaleString(undefined, { maximumFractionDigits: 4 }),
        usd: monUsd != null ? (monTotal * monUsd).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null,
        pool: null,
      },
      priceMon: virtualToken > 0 ? virtualMon / virtualToken : null,
    };
  }
  return null;
}

async function probeMarket(
  info: TokenInfo, address: Address, totalSupply: string | null, nadFunStatus: NadFunStatus,
): Promise<TokenMarketData> {
  const key = address.toLowerCase();
  const hit = marketCache.get(key);
  if (hit && Date.now() - hit.at < MARKET_TTL_MS) return hit.data;

  const stablecoin = getStablecoin();
  const quoteAssetsChecked = QUOTE_ASSETS.filter((qa) => {
    if (qa === "USDC" && address.toLowerCase() === stablecoin.address.toLowerCase()) return false;
    if (qa === "MON" && info.symbol.toUpperCase() === "MON") return false;
    return true;
  });

  const [routes, directUsdPrice, nadFunLiquidity, dexScreener, monUsdPrice] = await Promise.all([
    discoverRoutes(info, address, QUOTE_ASSETS, "1"),
    getUsdPrice(address, info.decimals),
    nadFunStatus.recognized ? probeNadFunLiquidity(address, info.decimals, nadFunStatus.status) : Promise.resolve(null),
    getDexScreenerSnapshot(address),
    // Already cached (60s) and read again by probeNadFunLiquidity below, so
    // this costs nothing extra — see prices.ts's own module-level cache.
    getUsdPrice(NATIVE_TOKEN_ADDRESS, 18),
  ]);
  const liquidity = nadFunLiquidity?.liquidity ?? null;

  // A real route quote wins when one exists. Otherwise, for a Nad.Fun-
  // recognized token whose Lens quote itself failed (verified live against
  // JAMES — see NadFunLiquidityProbe's own doc), fall back to the spot price
  // implied by the SAME reserves already fetched for the liquidity figure,
  // rather than show "Unavailable" next to a token with a real, indexed pool.
  const priceMon = routes.find((r) => r.outputToken === "MON")?.estimatedOutput
    ?? (nadFunLiquidity?.priceMon != null
      ? nadFunLiquidity.priceMon.toFixed(nadFunLiquidity.priceMon < 1 ? 8 : 4)
      : null);
  const usdPrice = directUsdPrice ?? deriveUsdFromMon(priceMon, monUsdPrice);

  // On-chain first, DexScreener only where on-chain genuinely yields nothing —
  // which covers two different gaps, not just one:
  //   - a GRADUATED Nad.Fun token has no curve reserves left to read and its
  //     dexFactory.getPair() reverts (both verified live against BOB), so the
  //     on-chain path fires and comes back null.
  //   - `liquidity` above is Promise.resolve(null) outright for anything
  //     Nad.Fun doesn't recognize — including a perfectly ordinary Uniswap
  //     token like WMON — because this app has no v3-compatible
  //     liquidity-depth read (v3 is concentrated liquidity, not simple x*y=k
  //     reserves). That was a real, previously-undocumented gap: EVERY
  //     Uniswap-only token showed "Unavailable" for liquidity, full stop.
  // Either way there is no second on-chain number to contradict — the
  // original "one source only" rule was about avoiding two disagreeing
  // figures, and with nothing to disagree with, the real indexed figure beats
  // showing "Unavailable" next to a token the card is actively quoting.
  const liquidityResolved: TokenLiquidity | null =
    liquidity ??
    (dexScreener?.liquidityUsd != null
      ? {
          label: "DEX Liquidity",
          mon: monUsdPrice != null && monUsdPrice > 0
            ? (dexScreener.liquidityUsd / monUsdPrice).toLocaleString(undefined, { maximumFractionDigits: 4 })
            : "—",
          usd: dexScreener.liquidityUsd.toLocaleString(undefined, { maximumFractionDigits: 2 }),
          pool: dexScreener.pool,
        }
      : null);

  const valuation = computeUsdValuation(usdPrice, totalSupply);
  const data: TokenMarketData = {
    price: usdPrice != null ? usdPrice.toFixed(usdPrice < 1 ? 8 : 4) : null,
    priceQuoteAsset: usdPrice != null ? "USD" : null,
    priceMon,
    marketCapUsd: valuation,
    fdvUsd: valuation,
    liquidity: liquidityResolved,
    volume24h: dexScreener != null ? dexScreener.volume24h.toLocaleString(undefined, { maximumFractionDigits: 2 }) : null,
    // DexScreener reports total volume and transaction counts per window,
    // never volume split by side — see dexscreener.ts's own doc for why
    // these stay null rather than an invented buy/sell split.
    buyVolume24h: null,
    sellVolume24h: null,
    transactions24h: dexScreener?.transactions24h ?? null,
    buys24h: dexScreener?.buys24h ?? null,
    sells24h: dexScreener?.sells24h ?? null,
    holders: null,
    priceChange24h: dexScreener?.priceChange24h != null ? fmtSignedPct(dexScreener.priceChange24h) : null,
    quoteAssetsChecked,
    routes,
    signals: computeSignals(routes, usdPrice, quoteAssetsChecked, liquidityResolved != null),
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
  // Latency Task 3: nadFunAvailableBuyTokens() and getNadFunProgress() used
  // to wait for getNadFunStatus() to resolve first, purely because the old
  // code decided whether to CALL them based on the status it returned — an
  // unnecessary sequential RPC round trip. Both read the SAME Lens contract
  // as isGraduated()/isLocked() and, per lib/monad/nadfun.ts's own verified
  // behavior, fail the identical way (a caught revert -> null) for a token
  // the Lens doesn't recognize at all — so there is nothing unsafe about
  // firing all four concurrently and deciding AFTER they resolve whether the
  // now-known status actually makes each one meaningful. For a genuinely
  // non-Nad.Fun token this costs two harmless, already-parallel extra reads
  // (no added latency, since they finish alongside isGraduated/isLocked);
  // for a Nad.Fun token — the case this product is actively promoting right
  // now — it removes a whole sequential hop. getNadFunCreatorInfo() is
  // deliberately NOT included here: it's a `getLogs` call, not a simple Lens
  // view read, and its cost/range-limit behavior against the real production
  // RPC provider is unverified (see the Step 7 report) — it stays gated on
  // a CONFIRMED recognized status rather than fired speculatively for every
  // token this app has never seen before.
  const [totalSupply, nadFunStatus, availabilityRaw, progressRaw] = await Promise.all([
    readTotalSupply(pub, addr, info.decimals),
    getNadFunStatus(addr),
    nadFunAvailableBuyTokens(addr, info.decimals),
    getNadFunProgress(addr),
  ]);
  const [userBalance, market, creatorInfo] = await Promise.all([
    walletAddress ? readBalance(pub, addr, walletAddress as Address, info.decimals) : Promise.resolve(null),
    probeMarket(info, addr, totalSupply, nadFunStatus),
    nadFunStatus.recognized ? getNadFunCreatorInfo(addr) : Promise.resolve(null),
  ]);

  let nadFun: TokenNadFunInfo | null = null;
  let creator: string | null = null;
  let pool: string | null = null;
  let createdAt: number | null = null;
  if (nadFunStatus.recognized) {
    nadFun = {
      status: nadFunStatus.status,
      isLocked: nadFunStatus.isLocked,
      // Only trusted for the status it's actually meaningful for — the read
      // itself already happened above regardless of status; this is purely
      // about what's SHOWN, exactly matching the old gating logic's outcome.
      availableToBuy: nadFunStatus.status === "bonding_curve" ? availabilityRaw?.availableToBuy ?? null : null,
      progressPct: nadFunStatus.status !== "graduated" ? progressRaw : null,
    };
    creator = creatorInfo?.creator ?? null;
    createdAt = creatorInfo?.createdAt ?? null;
    // The RELEVANT active pool: the graduated DEX pair once one exists
    // (already resolved inside probeMarket's liquidity read, reused here
    // rather than re-fetched), otherwise the original bonding-curve pool —
    // never an obsolete bonding-curve address shown after graduation.
    pool = market.liquidity?.label === "DEX Liquidity" ? market.liquidity.pool : creatorInfo?.curvePool ?? null;
  }

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
      creator,
      pool,
      createdAt,
      ...(quote !== undefined ? { quote } : {}),
      nadFun,
    },
  };
}
