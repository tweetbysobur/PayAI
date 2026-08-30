/**
 * Trade Quote & Validation — Steps 3+4 of the PayAI Trading Engine.
 *
 * previewTrade() (Step 3) turns a structured trade request into a real,
 * validated quote preview — read-only, never touches a wallet's signer.
 *
 * prepareTradeExecution() (Step 4) is the ONLY function in this module that
 * builds an unsigned transaction, and it still never signs or submits
 * anything — it re-quotes fresh (never trusts the caller's earlier preview),
 * compares against what the caller says it's currently showing, and only
 * returns real unsigned steps when nothing material has changed. Signing
 * itself happens exclusively in lib/ask/intent/orchestrate.ts's
 * executeTradeIntent, through the SAME wallet the rest of the app already
 * uses (wallet.sendTransaction/waitForReceipt) — nothing here ever sees a
 * private key, and nothing here is reachable except from an explicit
 * "Confirm trade" click on an already-previewed card (see
 * components/ask/OperationCard.tsx's TradePreviewBody).
 *
 * Reuses, never duplicates:
 *  - lib/monad/tokenRegistry's resolveToken() / lib/monad/swap's
 *    resolveSwapSide() to identify either side by ADDRESS or SYMBOL — the
 *    exact same dual path lib/monad/tokenIntelligence.ts already
 *    established, so a symbol only ever resolves through the curated
 *    registry (verified=true, safe) and an address always resolves to
 *    itself (never assumed tradable just because it exists).
 *  - lib/monad/swap's bestQuote() when BOTH sides are verified (safe to
 *    route by symbol), or quoteUniswapDirect() when either side is an
 *    arbitrary/unverified token — the SAME quoting primitives Step 2's
 *    market intelligence already uses, not a second quote engine.
 *  - lib/monad/swap's DEFAULT_SLIPPAGE/MAX_SLIPPAGE/MAX_PRICE_IMPACT — the
 *    existing, already-hardened limits; never redefined here.
 *  - lib/monad/balance's getTokenBalance()/GAS_RESERVE_MON for real balance
 *    checks (percentage/balance_all amounts, and rejecting an exact amount
 *    the wallet can't actually cover) — the same reserve logic
 *    insufficientBalanceReason() already applies to MON, generalized to
 *    any token.
 *  - lib/monad/prices's getUsdPrice() for USD-denominated amounts.
 *
 * Server-only.
 */
import "server-only";
import type { Address } from "viem";
import { getNetwork } from "./config";
import { resolveToken } from "./tokenRegistry";
import {
  bestQuote, buildUniswapPlanDirect, DEFAULT_SLIPPAGE, getSwapProvider, MAX_PRICE_IMPACT, MAX_SLIPPAGE,
  quoteUniswapDirect, resolveSwapSide, type UnsignedStep,
} from "./swap";
import { buildNadFunBuyPlan, buildNadFunSellPlan, getNadFunStatus, nadFunQuote } from "./nadfun";
import {
  buildKuruExecutorPlan, buildNadFunExecutorPlan, buildUniswapExecutorPlan, getExecutorFeeBps, selectExecutor, type ExecutorVenue,
} from "./tradeExecutor";
import { GAS_RESERVE_MON, getTokenBalance } from "./balance";
import { getUsdPrice } from "./prices";
import { toParseableAmount } from "./verify";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export type TradeAction = "buy" | "sell";
export type TradeAmountType = "exact_input" | "exact_output" | "usd" | "percentage" | "balance_all";

export interface TradePreviewRequest {
  action: TradeAction;
  /** What's being spent — a symbol ("USDC") or a contract address. */
  inputToken: string;
  /** What's being acquired — a symbol or a contract address. */
  outputToken: string;
  amount: string;
  amountType: TradeAmountType;
  /** A percent number ("1" for 1%), or null/absent to use DEFAULT_SLIPPAGE. */
  slippage?: string | null;
  walletAddress?: string | null;
}

export interface TradeRouteInfo {
  provider: string;
  /** [inputSymbol, outputSymbol] for a direct hop — still the overwhelming
   *  majority of trades, since neither Uniswap's QuoterV2 call nor Kuru's
   *  simulate call used anywhere in this codebase does multi-hop routing on
   *  its own. [inputSymbol, "MON", outputSymbol] for the one real exception:
   *  a Nad.Fun-only token (see getNadFunMultiHopRoute's own doc) routed
   *  through two independent, separately-signed on-chain legs. Never a
   *  fabricated path — every hop here is a real quote that was actually
   *  obtained. */
  path: string[];
}

export interface TradePreviewOk {
  ok: true;
  action: TradeAction;
  spend: { amount: string; token: string };
  receive: { amount: string; token: string };
  rate: string;
  minimumReceived: string;
  priceImpact: string | null;
  highPriceImpact: boolean;
  route: TradeRouteInfo;
  slippage: string;
  network: "Monad";
  quotedAt: number;
  /** The PayAI platform fee for this trade — present only when it will route
   *  through PayAITradeExecutor (Uniswap/Kuru with the flag on). null when the
   *  trade uses a direct path (Nad.Fun, or the flag off) and pays no PayAI fee.
   *  When present, `receive`/`minimumReceived` are already NET of this fee. */
  fee: { percent: string; amount: string; token: string } | null;
}

export interface TradePreviewErr {
  ok: false;
  message: string;
}

export type TradePreviewResult = TradePreviewOk | TradePreviewErr;

interface ResolvedTradeSide {
  symbol: string;
  /** The address actually routed through — WMON for native MON. */
  address: Address;
  decimals: number;
  isNative: boolean;
  /** True only when byte-exact in the curated registry (or the native MON
   *  special case) — see lib/monad/tokenIntelligence's own doc for why this
   *  is the ONLY thing that makes it safe to quote by symbol at all. */
  verified: boolean;
}

/** Resolves EITHER a raw contract address (works for any real ERC-20,
 *  curated or not — the contract address is always the source of truth) OR
 *  a symbol (curated registry only). Throws with an honest, user-facing
 *  message either way; never silently falls back to a guess. */
async function resolveTradeSide(input: string): Promise<ResolvedTradeSide> {
  const trimmed = input.trim();
  if (ADDR_RE.test(trimmed)) {
    const info = await resolveToken(trimmed); // throws if it doesn't behave like an ERC-20
    return { symbol: info.symbol, address: trimmed as Address, decimals: info.decimals, isNative: false, verified: info.verified };
  }
  const side = await resolveSwapSide(trimmed); // throws "isn't a token PayAI can swap yet" if unrecognized
  return { symbol: side.symbol, address: side.routeAddress, decimals: side.decimals, isNative: side.isNative, verified: true };
}

function validateSlippage(requested: string | null): { ok: true; slippage: number } | { ok: false; error: string } {
  if (!requested) return { ok: true, slippage: DEFAULT_SLIPPAGE };
  const pct = Number(requested);
  if (!Number.isFinite(pct) || pct < 0) return { ok: false, error: "That slippage value doesn't look valid." };
  const fraction = pct / 100;
  if (fraction > MAX_SLIPPAGE) {
    return { ok: false, error: `${pct}% slippage is above PayAI's ${(MAX_SLIPPAGE * 100).toFixed(0)}% safety ceiling — try a lower value.` };
  }
  return { ok: true, slippage: fraction };
}

/** Converts a requested amount + how it was phrased into a concrete number
 *  of INPUT-token units. exact_output is recognized but deliberately not
 *  resolved — this app's quote infrastructure (Uniswap's quoteExactInputSingle,
 *  Kuru's simulate-a-sell) only supports exact-INPUT quoting; guessing an
 *  input amount backwards from a desired output would require a different
 *  on-chain call this codebase doesn't make anywhere, so this is marked
 *  unsupported rather than approximated. */
async function resolveAmountInInputUnits(
  amountType: TradeAmountType, amount: string, inputSide: ResolvedTradeSide, walletAddress: string | null,
): Promise<{ ok: true; amount: number } | { ok: false; error: string }> {
  if (amountType === "exact_output") {
    return { ok: false, error: "I can't quote an exact-output trade yet — tell me how much you'd like to spend instead, and I'll quote what you'd receive for it." };
  }

  if (amountType === "percentage" || amountType === "balance_all") {
    if (!walletAddress) return { ok: false, error: "Connect your wallet so I can check your balance for that." };
    let balance: number;
    try {
      balance = await getTokenBalance(walletAddress as Address, inputSide.address, inputSide.decimals, inputSide.isNative);
    } catch {
      return { ok: false, error: `Couldn't read your ${inputSide.symbol} balance right now. Try again in a moment.` };
    }
    const usable = inputSide.isNative ? Math.max(0, balance - GAS_RESERVE_MON) : balance;
    if (amountType === "balance_all") return { ok: true, amount: usable };
    const pct = Number(amount);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { ok: false, error: "That percentage doesn't look valid." };
    return { ok: true, amount: usable * (pct / 100) };
  }

  const requested = Number(amount);
  if (!Number.isFinite(requested) || requested <= 0) return { ok: false, error: "That doesn't look like a valid amount." };

  if (amountType === "exact_input") return { ok: true, amount: requested };

  // usd
  if (inputSide.symbol.toUpperCase() === "USDC") return { ok: true, amount: requested }; // 1 USDC ≈ $1 — same numeraire convention as prices.ts
  const usdPrice = await getUsdPrice(inputSide.address, inputSide.decimals);
  if (usdPrice == null || usdPrice <= 0) {
    return { ok: false, error: `I couldn't get a reliable USD price for ${inputSide.symbol} to convert that.` };
  }
  return { ok: true, amount: requested / usdPrice };
}

/** Real, freshly-read balance check for a plain (non-percentage) amount —
 *  percentage/balance_all requests are already balance-bounded by
 *  construction (see resolveAmountInInputUnits) and skip this. Never blocks
 *  on an RPC hiccup (matches lib/monad/balance's insufficientBalanceReason
 *  precedent) or when no wallet is connected yet (nothing to check against). */
async function checkSufficientBalance(
  inputSide: ResolvedTradeSide, amountNeeded: number, walletAddress: string | null,
): Promise<{ ok: true } | { ok: false; available: number }> {
  if (!walletAddress) return { ok: true };
  try {
    const balance = await getTokenBalance(walletAddress as Address, inputSide.address, inputSide.decimals, inputSide.isNative);
    const usable = inputSide.isNative ? Math.max(0, balance - GAS_RESERVE_MON) : balance;
    if (usable < amountNeeded) return { ok: false, available: usable };
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

interface RawRoute {
  provider: string;
  amountOut: string;
  priceImpact: string | null;
}

/** True when exactly one side of this pair is native MON — the only shape a
 *  Nad.Fun trade can ever take (its bonding curve and post-graduation DEX
 *  pool both pair a token against MON, never against another ERC-20). Both
 *  sides MON, or neither, is never a Nad.Fun pair. */
function nadFunSides(input: ResolvedTradeSide, output: ResolvedTradeSide): { tokenSide: ResolvedTradeSide; isBuy: boolean } | null {
  const inputIsMon = input.isNative && input.symbol.toUpperCase() === "MON";
  const outputIsMon = output.isNative && output.symbol.toUpperCase() === "MON";
  if (inputIsMon === outputIsMon) return null;
  return inputIsMon ? { tokenSide: output, isBuy: true } : { tokenSide: input, isBuy: false };
}

/** Nad.Fun route discovery — tried BEFORE the generic Uniswap-direct probe
 *  below for any MON<->arbitrary-token pair, since a bonding-curve token has
 *  no Uniswap pool at all until it graduates (see lib/monad/nadfun.ts's own
 *  doc). Returns null immediately for any pair Nad.Fun can't possibly serve
 *  (either both sides or neither is MON) or that its Lens doesn't recognize
 *  — the caller falls through to Uniswap exactly as it always did. */
async function getNadFunRoute(input: ResolvedTradeSide, output: ResolvedTradeSide, amount: string): Promise<RawRoute | null> {
  const sides = nadFunSides(input, output);
  if (!sides) return null;
  const q = await nadFunQuote(sides.tokenSide.address, sides.tokenSide.decimals, amount, sides.isBuy);
  return q ? { provider: "Nad.Fun", amountOut: q.amountOut, priceImpact: null } : null;
}

/** Joins the two leg providers in a multi-hop route's composite provider
 *  string (e.g. "Uniswap v3 + Nad.Fun") — a single constant so construction
 *  (getNadFunMultiHopRoute) and detection (isMultiHopProvider) can never
 *  drift apart. */
const MULTI_HOP_JOIN = " + ";

/** True for a composite multi-hop provider string built by
 *  getNadFunMultiHopRoute — distinguishes it from a single real venue name
 *  (which never contains this join) so callers never mistake a two-leg
 *  route for one Uniswap/Kuru/Nad.Fun trade (see previewTrade's fee block
 *  and venueForProvider's own doc for why that distinction matters: a
 *  naive `/uniswap/i` match against "Uniswap v3 + Nad.Fun" would otherwise
 *  wrongly select the Uniswap executor for a trade that isn't one). */
function isMultiHopProvider(provider: string): boolean {
  return provider.includes(MULTI_HOP_JOIN);
}

/** Quotes counterSide -> MON ("toMon") or MON -> counterSide ("fromMon"),
 *  reusing bestQuote() when both sides are verified (symbol-safe) or
 *  quoteUniswapDirect() otherwise — the exact same two primitives
 *  getTradeRoute()'s own verified/arbitrary split already uses, just aimed
 *  at MON specifically rather than the caller's real output token. */
async function quoteToMon(counterSide: ResolvedTradeSide, monSide: ResolvedTradeSide, amount: string, direction: "toMon" | "fromMon"): Promise<RawRoute | null> {
  const [inSide, outSide] = direction === "toMon" ? [counterSide, monSide] : [monSide, counterSide];
  if (inSide.verified && outSide.verified) {
    try {
      const { provider, quote } = await bestQuote(inSide.symbol, outSide.symbol, Number(amount));
      return { provider: provider.name, amountOut: String(quote.amountOut), priceImpact: quote.priceImpact != null ? `${(quote.priceImpact * 100).toFixed(2)}%` : null };
    } catch {
      return null;
    }
  }
  const direct = await quoteUniswapDirect(inSide.address, inSide.decimals, outSide.address, outSide.decimals, amount);
  return direct ? { provider: "Uniswap v3", amountOut: direct.amountOut, priceImpact: direct.priceImpact } : null;
}

/**
 * A Nad.Fun-only token routed through MON as a real, two-leg intermediate
 * hop — the follow-up to nadFunCounterAssetHint's diagnosis: rather than
 * only EXPLAINING that "0xD10cf1...785657777 trades on Nad.Fun, but only
 * against MON," actually quote the honest two-transaction path (spend ->
 * MON -> token, or token -> MON -> receive) so the trade can genuinely
 * happen without the user manually doing two separate trades themselves.
 *
 * Only reached after every direct route in getTradeRoute() has already
 * failed, and only proceeds when the non-MON side is actually Nad.Fun-
 * recognized (mirrors nadFunCounterAssetHint's own gating) — a genuinely
 * illiquid token still gets an honest "no route" rather than a fabricated
 * multi-hop quote. Both legs are real, independently-obtained quotes
 * (quoteToMon reuses bestQuote()/quoteUniswapDirect(); nadFunQuote() is the
 * same Lens-backed read every other Nad.Fun quote in this file uses) —
 * never a guessed or interpolated number.
 *
 * Deliberately two real on-chain legs, not a fabricated single hop: there is
 * no deployed contract on Monad that atomically chains a Uniswap swap and a
 * Nad.Fun trade in one transaction, so this always means two separate
 * signatures at execution time (see buildNadFunMultiHopSteps) — the preview
 * here exists to show that honestly, not to pretend it's one trade.
 */
async function getNadFunMultiHopRoute(action: TradeAction, input: ResolvedTradeSide, output: ResolvedTradeSide, amount: string): Promise<RawRoute | null> {
  const isBuy = action === "buy";
  const tokenSide = isBuy ? output : input;
  const counterSide = isBuy ? input : output;
  // Either side already being MON means nadFunSides() above would have
  // tried (and failed) the direct route — hopping "through" MON when one
  // side already IS MON is meaningless, so this only ever applies to a
  // genuinely non-MON counter-asset.
  if (tokenSide.isNative || counterSide.isNative) return null;

  let status;
  try {
    status = await getNadFunStatus(tokenSide.address);
  } catch {
    return null;
  }
  if (!status.recognized) return null;

  const monSide = await resolveTradeSide("MON");

  if (isBuy) {
    // Leg A: counter-asset -> MON. Leg B: MON -> token, sized off Leg A's
    // real quoted output (never the original request amount).
    const legA = await quoteToMon(counterSide, monSide, amount, "toMon");
    if (!legA) return null;
    const legB = await nadFunQuote(tokenSide.address, tokenSide.decimals, legA.amountOut, true);
    if (!legB) return null;
    return { provider: `${legA.provider}${MULTI_HOP_JOIN}Nad.Fun`, amountOut: legB.amountOut, priceImpact: legA.priceImpact };
  }
  // Leg A: token -> MON. Leg B: MON -> counter-asset, sized off Leg A's
  // real quoted MON output.
  const legA = await nadFunQuote(tokenSide.address, tokenSide.decimals, amount, false);
  if (!legA) return null;
  const legB = await quoteToMon(counterSide, monSide, legA.amountOut, "fromMon");
  if (!legB) return null;
  return { provider: `Nad.Fun${MULTI_HOP_JOIN}${legB.provider}`, amountOut: legB.amountOut, priceImpact: legB.priceImpact };
}

/** The real quote: bestQuote() (symbol-safe, both sides verified), Nad.Fun
 *  (a bonding-curve or newly-graduated MON<->token pair), quoteUniswapDirect()
 *  (address-based, at least one side arbitrary), or — only once all three of
 *  those have already failed — the two-leg Nad.Fun-through-MON route (see
 *  getNadFunMultiHopRoute's own doc). */
async function getTradeRoute(input: ResolvedTradeSide, output: ResolvedTradeSide, amount: string, action: TradeAction): Promise<RawRoute | null> {
  if (input.verified && output.verified) {
    try {
      const { provider, quote } = await bestQuote(input.symbol, output.symbol, Number(amount));
      return { provider: provider.name, amountOut: String(quote.amountOut), priceImpact: quote.priceImpact != null ? `${(quote.priceImpact * 100).toFixed(2)}%` : null };
    } catch {
      return null;
    }
  }
  const nadFun = await getNadFunRoute(input, output, amount);
  if (nadFun) return nadFun;
  const direct = await quoteUniswapDirect(input.address, input.decimals, output.address, output.decimals, amount);
  if (direct) return { provider: "Uniswap v3", amountOut: direct.amountOut, priceImpact: direct.priceImpact };
  return getNadFunMultiHopRoute(action, input, output, amount);
}

/**
 * Explains WHY, when getTradeRoute() above found nothing — never changes
 * whether a route is found, only how a real "no route" is worded.
 *
 * A real, live-liquidity Nad.Fun token (bonding-curve or graduated) that a
 * user tries to trade against anything OTHER than MON — most commonly USDC,
 * either named explicitly or defaulted to by classify.ts's
 * applyTradeContext() when "sell TOKEN" doesn't say what to receive — was
 * getting the exact same generic "No usable trading route found" as a token
 * with genuinely zero liquidity anywhere. Both nadFunSides() (this file, MON
 * is the only counter-asset Nad.Fun's bonding curve or its post-graduation
 * pool ever pairs against — see nadfun.ts's own doc) and the real Uniswap V3
 * quoter (that graduated pool lives in Nad.Fun's OWN separate Uniswap-V2-fork
 * factory, never Uniswap's) correctly find nothing for TOKEN<->USDC, so the
 * generic message wasn't wrong about THAT quote — it just left "this token
 * has no liquidity at all" and "this token only trades against MON"
 * indistinguishable, when the difference is exactly the one actionable fact
 * the user needs.
 *
 * Only runs after getTradeRoute() has already failed (one extra read, paid
 * only on the failure path, not on every quote) and only changes the message
 * — it never fabricates a route, never quotes through Nad.Fun for a pair
 * nadFunSides() itself would refuse, and never touches what actually gets
 * built or signed.
 */
async function nadFunCounterAssetHint(input: ResolvedTradeSide, output: ResolvedTradeSide): Promise<string | null> {
  if (nadFunSides(input, output)) return null; // one side WAS MON -- Nad.Fun was already tried above
  // Whichever side isn't a curated symbol is the one that could plausibly be
  // a Nad.Fun token; a curated symbol (MON/USDC/USDT0/AUSD/WETH/WBTC) never is.
  const candidate = !input.verified ? input : !output.verified ? output : null;
  if (!candidate) return null;
  try {
    const status = await getNadFunStatus(candidate.address);
    if (!status.recognized) return null;
    return `${candidate.symbol} trades on Nad.Fun, but only against MON right now — try quoting it against MON instead of ${input.address.toLowerCase() === candidate.address.toLowerCase() ? output.symbol : input.symbol}.`;
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  return n.toFixed(n !== 0 && Math.abs(n) < 1 ? 8 : 4);
}

/** Maps a route's provider name to the ExecutorVenue selectExecutor()
 *  understands, or null for a provider that never routes through an
 *  executor. A non-allowlisted Kuru market or Nad.Fun router silently falls
 *  back to the direct path at build time, delivering the slightly-larger
 *  no-fee amount, so treating a venue as executor-eligible in the preview
 *  only ever under-promises. */
function venueForProvider(provider: string): ExecutorVenue | null {
  if (/uniswap/i.test(provider)) return "uniswap";
  if (provider === "Kuru") return "kuru";
  if (provider === "Nad.Fun") return "nadfun";
  return null;
}

/**
 * The single entry point. Every validation step the spec asks for runs here,
 * in order, and any failure returns an honest `ok: false` message — never a
 * preview built on a guess. A successful result is a real, just-fetched
 * quote and nothing else; nothing about calling this signs or moves funds.
 */
export async function previewTrade(req: TradePreviewRequest): Promise<TradePreviewResult> {
  if (getNetwork() !== "mainnet") return { ok: false, message: "Trading is only available on Monad mainnet right now." };

  let inputSide: ResolvedTradeSide;
  try {
    inputSide = await resolveTradeSide(req.inputToken);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : `I couldn't identify ${req.inputToken}.` };
  }
  let outputSide: ResolvedTradeSide;
  try {
    outputSide = await resolveTradeSide(req.outputToken);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : `I couldn't identify ${req.outputToken}.` };
  }
  if (inputSide.address.toLowerCase() === outputSide.address.toLowerCase()) {
    return { ok: false, message: "Choose two different tokens to trade." };
  }

  const slippageResult = validateSlippage(req.slippage ?? null);
  if (!slippageResult.ok) return { ok: false, message: slippageResult.error };

  const amountResult = await resolveAmountInInputUnits(req.amountType, req.amount, inputSide, req.walletAddress ?? null);
  if (!amountResult.ok) return { ok: false, message: amountResult.error };
  if (amountResult.amount <= 0) return { ok: false, message: `You don't have any ${inputSide.symbol} available to trade.` };

  if (req.amountType === "exact_input" || req.amountType === "usd") {
    const bal = await checkSufficientBalance(inputSide, amountResult.amount, req.walletAddress ?? null);
    if (!bal.ok) {
      const available = bal.available.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
      return { ok: false, message: `You only have ${available} ${inputSide.symbol} available — that's less than the ${amountResult.amount} ${inputSide.symbol} you asked to trade.` };
    }
  }

  // String()/.toString() on a computed amount (percentage-of-balance, a
  // USD/price division) switches to exponential notation below 1e-6 — e.g.
  // "1e-7" — which reads badly as a trade amount AND breaks every quoting
  // call downstream (nadFunQuote/quoteUniswapDirect eventually hand this
  // straight to viem's parseUnits, which rejects it outright). Only
  // reformat in that case; toFixed(decimals) is exact-precision-safe here
  // specifically because it only ever fires on values already this small,
  // and it leaves every normal-sized amount's display untouched.
  const rawAmountStr = String(amountResult.amount);
  const amountStr = /e/i.test(rawAmountStr) ? toParseableAmount(amountResult.amount, inputSide.decimals) : rawAmountStr;
  const route = await getTradeRoute(inputSide, outputSide, amountStr, req.action);
  if (!route) {
    const nadFunHint = await nadFunCounterAssetHint(inputSide, outputSide);
    return { ok: false, message: nadFunHint ?? `No usable trading route found for ${inputSide.symbol} → ${outputSide.symbol} right now.` };
  }
  const multiHop = isMultiHopProvider(route.provider);

  const grossOut = Number(route.amountOut);
  // When this trade will route through PayAITradeExecutor (Uniswap/Kuru, flag
  // on), the executor takes its fee off the input and swaps only the net, so
  // the honest "you receive" is net of that fee. Nad.Fun and the flag-off path
  // pay no PayAI fee, so their numbers are unchanged. The net figure here is an
  // estimate (gross scaled by the fee); prepareTradeExecution re-quotes the net
  // exactly and sets the real on-chain minOut. A multi-hop route never gets a
  // single blended fee line here — venueForProvider would otherwise mismatch a
  // composite "Uniswap v3 + Nad.Fun" string against a single venue (see
  // isMultiHopProvider's own doc); each leg's real fee, if any, is disclosed
  // honestly per-leg at build time instead (buildNadFunMultiHopSteps).
  let fee: TradePreviewOk["fee"] = null;
  let effOut = grossOut;
  let effReceiveStr = route.amountOut;
  if (!multiHop) {
    const previewVenue = venueForProvider(route.provider);
    const previewExec = previewVenue ? selectExecutor(previewVenue) : null;
    if (previewExec) {
      const feeBps = await getExecutorFeeBps(previewExec);
      effOut = grossOut * (1 - feeBps / 10000);
      effReceiveStr = fmt(effOut);
      fee = { percent: `${(feeBps / 100).toFixed(2)}%`, amount: fmt(amountResult.amount * (feeBps / 10000)), token: inputSide.symbol };
    }
  }

  const rate = amountResult.amount > 0 ? effOut / amountResult.amount : 0;
  const minReceived = effOut * (1 - slippageResult.slippage);
  const impactFraction = route.priceImpact ? parseFloat(route.priceImpact) / 100 : null;

  return {
    ok: true,
    action: req.action,
    spend: { amount: amountStr, token: inputSide.symbol },
    receive: { amount: effReceiveStr, token: outputSide.symbol },
    rate: `1 ${inputSide.symbol} ≈ ${fmt(rate)} ${outputSide.symbol}`,
    minimumReceived: `${fmt(minReceived)} ${outputSide.symbol}`,
    priceImpact: route.priceImpact,
    highPriceImpact: impactFraction != null && impactFraction > MAX_PRICE_IMPACT,
    route: { provider: route.provider, path: multiHop ? [inputSide.symbol, "MON", outputSide.symbol] : [inputSide.symbol, outputSide.symbol] },
    slippage: `${(slippageResult.slippage * 100).toFixed(2)}%`,
    network: "Monad",
    quotedAt: Date.now(),
    fee,
  };
}

export interface TradeExecutionStep {
  kind: "approve" | "swap";
  label: string;
  tx: { to: string; data: string; value: string };
}

export interface TradeExecutionReady {
  ok: true;
  status: "ready";
  preview: TradePreviewOk;
  steps: TradeExecutionStep[];
}

/** Nothing was built — the fresh quote moved enough (or the route changed)
 *  that executing against what the user was previously shown would be
 *  executing a materially different trade than the one they approved. */
export interface TradeExecutionChanged {
  ok: true;
  status: "changed";
  preview: TradePreviewOk;
}

export type TradeExecutionResult = TradeExecutionReady | TradeExecutionChanged | TradePreviewErr;

/** What the caller says it's CURRENTLY showing the user — compared against
 *  a brand-new quote to decide whether anything material moved. */
export interface PreviousQuoteSnapshot {
  receiveAmount: string;
  provider: string;
}

/** "Material" means: the route/provider changed, OR the receive amount
 *  moved by more than the request's OWN slippage tolerance would already
 *  protect against on-chain. Anything within that tolerance is exactly what
 *  slippage protection exists for — re-confirming it too would just be
 *  friction the spec doesn't ask for ("Do not silently execute a
 *  materially different trade" implies a threshold, not zero tolerance). */
function isMaterialChange(fresh: TradePreviewOk, previous: PreviousQuoteSnapshot | null | undefined, slippageFraction: number): boolean {
  if (!previous) return false;
  if (fresh.route.provider !== previous.provider) return true;
  const freshOut = Number(fresh.receive.amount);
  const prevOut = Number(previous.receiveAmount);
  if (!Number.isFinite(freshOut) || !Number.isFinite(prevOut) || prevOut <= 0) return true;
  return Math.abs(freshOut - prevOut) / prevOut > slippageFraction;
}

/**
 * The Step 4 entry point: re-quotes `req` completely fresh (ignoring
 * whatever the caller previously saw), and — only if nothing material
 * changed since `previous` — builds the real unsigned transaction steps for
 * it. Every validation previewTrade() already does (route exists, balance
 * sufficient, slippage valid, network correct, exact_output still
 * unsupported) applies here too, since this calls previewTrade() itself
 * rather than re-implementing any of it.
 *
 * Verified pairs reuse getSwapProvider().buildPlan() directly — the EXACT
 * function the existing, already-signed-in-production Smart Swap feature
 * uses, so a verified-token trade executes through literally the same code
 * path (approve logic, native wrap/unwrap, minAmountOut protection,
 * Kuru-or-Uniswap selection) as an ordinary swap. Arbitrary/unverified
 * pairs use buildUniswapPlanDirect() (Uniswap only — Kuru's own market list
 * is small and curated-symbol-keyed, so it was never reachable for these
 * pairs at the quote stage either; see previewTrade's own doc).
 */
export async function prepareTradeExecution(
  req: TradePreviewRequest, previous?: PreviousQuoteSnapshot | null,
): Promise<TradeExecutionResult> {
  if (!req.walletAddress) return { ok: false, message: "Connect your wallet to trade." };

  const preview = await previewTrade(req);
  if (!preview.ok) return preview;

  const slippageFraction = parseFloat(preview.slippage) / 100;
  if (isMaterialChange(preview, previous, slippageFraction)) {
    return { ok: true, status: "changed", preview };
  }

  let inputSide: ResolvedTradeSide;
  let outputSide: ResolvedTradeSide;
  try {
    // Re-resolved (not carried over from previewTrade's own internals) so
    // the addresses that actually go into the transaction are re-derived
    // from the exact same request strings previewTrade() just used —
    // cheap, since a curated symbol resolves statically and an
    // already-seen address is already permanently cached in tokenRegistry.
    inputSide = await resolveTradeSide(req.inputToken);
    outputSide = await resolveTradeSide(req.outputToken);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't prepare that trade." };
  }

  const wallet = req.walletAddress as Address;
  try {
    let steps: UnsignedStep[] | null = null;

    // Gate 5/7 — route through a PayAITradeExecutor when one is selected for
    // this venue (Uniswap any pool; Kuru allowlisted markets; Nad.Fun only
    // via V2, allowlisted routers — see selectExecutor()). Falls through to
    // the existing direct path when no executor applies OR the venue-specific
    // allowlist rejects it (Kuru market / Nad.Fun router not yet
    // Safe-approved) — nothing reverts, and Nad.Fun's own direct route below
    // is completely untouched by this branch. The executor builders
    // re-quote/size on the NET the executor actually swaps — the same net
    // the preview's fee line reflected.
    const buildVenue = venueForProvider(preview.route.provider);
    const buildExec = buildVenue ? selectExecutor(buildVenue) : null;
    if (buildExec) {
      if (buildVenue === "kuru") {
        const kplan = await buildKuruExecutorPlan(buildExec, inputSide.symbol, outputSide.symbol, inputSide.decimals, preview.spend.amount, slippageFraction, wallet);
        if (kplan) steps = kplan.steps;
      } else if (buildVenue === "nadfun") {
        const sides = nadFunSides(inputSide, outputSide);
        if (sides) {
          const nplan = await buildNadFunExecutorPlan(
            buildExec, sides.tokenSide.address, sides.tokenSide.symbol, sides.tokenSide.decimals, sides.isBuy,
            preview.spend.amount, slippageFraction, wallet,
          );
          if (nplan) steps = nplan.steps;
        }
      } else {
        const uplan = await buildUniswapExecutorPlan(
          buildExec,
          inputSide.address, inputSide.symbol, inputSide.decimals, inputSide.isNative,
          outputSide.address, outputSide.symbol, outputSide.decimals, outputSide.isNative,
          preview.spend.amount, slippageFraction, wallet,
        );
        steps = uplan.steps;
      }
    }

    if (steps) {
      // executor path already built
    } else if (inputSide.verified && outputSide.verified) {
      const plan = await getSwapProvider().buildPlan(inputSide.symbol, outputSide.symbol, Number(preview.spend.amount), wallet, slippageFraction);
      steps = plan.steps;
    } else if (preview.route.provider === "Nad.Fun") {
      // isMaterialChange() above already refused to proceed if the route
      // (provider) moved since the caller's last-seen preview, so by this
      // point preview.route.provider === "Nad.Fun" is exactly what was just
      // freshly re-quoted a few lines above via getTradeRoute() — this
      // re-derives buy-vs-sell the same cheap way getNadFunRoute() did
      // rather than threading extra state through, and buildNadFunBuyPlan/
      // buildNadFunSellPlan re-quote AGAIN via the Lens themselves before
      // building calldata, so what gets signed is never older than this call.
      const sides = nadFunSides(inputSide, outputSide);
      if (!sides) return { ok: false, message: "Couldn't prepare that Nad.Fun trade." };
      const plan = sides.isBuy
        ? await buildNadFunBuyPlan(sides.tokenSide.address, sides.tokenSide.symbol, sides.tokenSide.decimals, preview.spend.amount, slippageFraction, wallet)
        : await buildNadFunSellPlan(sides.tokenSide.address, sides.tokenSide.symbol, sides.tokenSide.decimals, preview.spend.amount, slippageFraction, wallet);
      steps = plan.steps;
    } else {
      const direct = await buildUniswapPlanDirect(
        inputSide.address, inputSide.symbol, inputSide.decimals, inputSide.isNative,
        outputSide.address, outputSide.symbol, outputSide.decimals, outputSide.isNative,
        preview.spend.amount, slippageFraction, wallet,
      );
      steps = direct.steps;
    }
    return { ok: true, status: "ready", preview, steps };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't prepare that trade for signing." };
  }
}
