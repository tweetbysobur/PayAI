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
import { bpsPercent, feeOnTop, fromUnits, maxNetFor, toUnits } from "@/lib/payment/feeOnTop";

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
  /** The PayAI platform fee for this trade, charged ON TOP of `spend` —
   *  present only when it routes through PayAITradeExecutor (Uniswap/Kuru/
   *  Nad.Fun-allowlisted, flag on); null for direct paths, which pay none.
   *  `spend` is swapped in full; `total` (spend + fee) leaves the balance. */
  fee: { percent: string; amount: string; token: string; total: string } | null;
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
  let route = await getTradeRoute(inputSide, outputSide, amountStr, req.action);
  if (!route) {
    const nadFunHint = await nadFunCounterAssetHint(inputSide, outputSide);
    return { ok: false, message: nadFunHint ?? `No usable trading route found for ${inputSide.symbol} → ${outputSide.symbol} right now.` };
  }
  const multiHop = isMultiHopProvider(route.provider);

  // PayAI's trade fee is ON TOP (lib/payment/feeOnTop.ts): when this trade
  // routes through PayAITradeExecutor, the amount shown as "spend" is swapped
  // IN FULL and the fee is debited from the balance in addition, so "you
  // receive" is the route's own output for that amount. Nad.Fun-direct and
  // the flag-off path pay no PayAI fee. A multi-hop route never gets a single
  // blended fee line (see isMultiHopProvider's own doc); its legs are direct.
  let fee: TradePreviewOk["fee"] = null;
  let spendStr = amountStr;
  let spendNum = amountResult.amount;
  if (!multiHop) {
    const previewVenue = venueForProvider(route.provider);
    const previewExec = previewVenue ? selectExecutor(previewVenue) : null;
    if (previewExec) {
      const feeBps = await getExecutorFeeBps(previewExec);
      const dec = inputSide.decimals;
      let netUnits = toUnits(toParseableAmount(amountResult.amount, dec), dec);
      if (netUnits === null || netUnits <= 0n) return { ok: false, message: "That amount can't be traded exactly — use fewer digits." };
      if (req.amountType === "percentage" || req.amountType === "balance_all") {
        // The computed amount is everything the user chose to use: what fits
        // with the fee on top is swapped, the fee comes out of the same total.
        netUnits = maxNetFor(netUnits, feeBps);
        if (netUnits <= 0n) return { ok: false, message: `You don't have enough ${inputSide.symbol} to cover the trade and PayAI's fee.` };
        spendStr = fromUnits(netUnits, dec);
        spendNum = Number(spendStr);
        const requoted = await getTradeRoute(inputSide, outputSide, spendStr, req.action);
        if (!requoted || requoted.provider !== route.provider) return { ok: false, message: `No usable trading route found for ${inputSide.symbol} → ${outputSide.symbol} right now.` };
        route = requoted;
      }
      const f = feeOnTop(netUnits, feeBps);
      fee = { percent: bpsPercent(feeBps), amount: fromUnits(f.fee, dec), token: inputSide.symbol, total: fromUnits(f.gross, dec) };
      if (req.amountType === "exact_input" || req.amountType === "usd") {
        const bal = await checkSufficientBalance(inputSide, Number(fee.total), req.walletAddress ?? null);
        if (!bal.ok) {
          const available = bal.available.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
          const max = toUnits(toParseableAmount(bal.available, dec), dec);
          const fits = max !== null ? fromUnits(maxNetFor(max, feeBps), dec) : null;
          const coversAmount = bal.available >= spendNum;
          return {
            ok: false,
            message: `You have ${available} ${inputSide.symbol}. This trade needs ${spendStr} ${inputSide.symbol} plus the ${fee.amount} ${inputSide.symbol} PayAI fee (${fee.total} in total).` +
              (coversAmount ? " Your balance covers the amount but not the fee on top." : "") +
              (fits && Number(fits) > 0 ? ` You can trade up to ${fits} ${inputSide.symbol}.` : ""),
          };
        }
      }
    }
  }
  const effOut = Number(route.amountOut);
  const effReceiveStr = route.amountOut;

  const rate = spendNum > 0 ? effOut / spendNum : 0;
  const minReceived = effOut * (1 - slippageResult.slippage);
  const impactFraction = route.priceImpact ? parseFloat(route.priceImpact) / 100 : null;

  return {
    ok: true,
    action: req.action,
    spend: { amount: spendStr, token: inputSide.symbol },
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
  /** Present only on the LAST step of a completed, independently-settleable
   *  on-chain leg (see buildNadFunMultiHopSteps). Tells the caller to
   *  record + notify THIS leg the moment its own receipt confirms — with
   *  its real fromToken/toToken/amounts/provider — rather than only ever
   *  settling once at the very end of the whole steps array. Absent for an
   *  ordinary single-leg trade, which keeps settling exactly as before:
   *  once, at the end, with the whole trade's own numbers. This is what
   *  lets "leg A succeeded, leg B was then rejected or reverted" leave a
   *  real record of leg A's real, fund-moving transaction, instead of a
   *  silent gap in the user's own history. */
  settleLeg?: { fromToken: string; toToken: string; amountIn: number; amountOut: number; provider: string };
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
 * Builds BOTH real on-chain legs of a Nad.Fun-through-MON trade fresh —
 * mirrors getNadFunMultiHopRoute's own two-leg sequencing exactly, but
 * builds real unsigned steps instead of a quote number. Leg B is always
 * sized off Leg A's REAL, just-built output (never the preview's earlier
 * estimate) — this file's "never sign what wasn't just quoted" rule,
 * applied across two legs instead of one.
 *
 * Throws on any failure rather than returning a partial result — exactly
 * like every other build* function in this file — so prepareTradeExecution's
 * existing try/catch turns it into the same honest `ok: false` a single-leg
 * build failure already gets. Never signs, submits, or leaves a trade
 * half-built: either both legs' steps come back together, or nothing does.
 *
 * Each leg's LAST step carries settleLeg (see TradeExecutionStep's own
 * doc), tagged with THAT leg's real fromToken/toToken/provider/amounts —
 * so a caller that settles as each leg's own receipt confirms (rather than
 * only once at the very end) records BOTH real, fund-moving transactions.
 * That is what makes "leg A succeeded, leg B was then rejected or
 * reverted" a state with an honest transaction-history record instead of a
 * silent gap — see lib/ask/intent/orchestrate.ts's executeTradeIntent.
 */
async function buildNadFunMultiHopSteps(
  action: TradeAction, input: ResolvedTradeSide, output: ResolvedTradeSide, amount: string, slippage: number, wallet: Address,
): Promise<TradeExecutionStep[]> {
  const isBuy = action === "buy";
  const tokenSide = isBuy ? output : input;
  const counterSide = isBuy ? input : output;
  if (tokenSide.isNative || counterSide.isNative) throw new Error("Couldn't prepare that Nad.Fun trade.");
  const monSide = await resolveTradeSide("MON");

  function tagLast(steps: UnsignedStep[], settleLeg: NonNullable<TradeExecutionStep["settleLeg"]>): TradeExecutionStep[] {
    return steps.map((s, i) => (i === steps.length - 1 ? { ...s, settleLeg } : s));
  }

  /** counterSide -> MON, or MON -> counterSide when `reverse`. Reuses
   *  getSwapProvider().buildPlan() (verified/verified — the exact path
   *  Smart Swap already signs in production) when the counter-asset is
   *  verified, else buildUniswapPlanDirect() (address-based) — the same
   *  split getTradeRoute()/quoteToMon() already use at quote time. */
  async function buildCounterLeg(amountIn: string, reverse: boolean): Promise<{ steps: UnsignedStep[]; amountOut: string; provider: string }> {
    const [inSide, outSide] = reverse ? [monSide, counterSide] : [counterSide, monSide];
    if (inSide.verified && outSide.verified) {
      const plan = await getSwapProvider().buildPlan(inSide.symbol, outSide.symbol, Number(amountIn), wallet, slippage);
      return { steps: plan.steps, amountOut: String(plan.quote.amountOut), provider: plan.provider ?? "PayAI" };
    }
    const plan = await buildUniswapPlanDirect(
      inSide.address, inSide.symbol, inSide.decimals, inSide.isNative,
      outSide.address, outSide.symbol, outSide.decimals, outSide.isNative,
      amountIn, slippage, wallet,
    );
    return { steps: plan.steps, amountOut: plan.amountOut, provider: "Uniswap v3" };
  }

  if (isBuy) {
    const legA = await buildCounterLeg(amount, false);
    const legASteps = tagLast(legA.steps, { fromToken: counterSide.symbol, toToken: "MON", amountIn: Number(amount), amountOut: Number(legA.amountOut), provider: legA.provider });

    const legB = await buildNadFunBuyPlan(tokenSide.address, tokenSide.symbol, tokenSide.decimals, legA.amountOut, slippage, wallet);
    const legBSteps = tagLast(legB.steps, { fromToken: "MON", toToken: tokenSide.symbol, amountIn: Number(legA.amountOut), amountOut: Number(legB.amountOut), provider: "Nad.Fun" });

    return [...legASteps, ...legBSteps];
  }

  const legA = await buildNadFunSellPlan(tokenSide.address, tokenSide.symbol, tokenSide.decimals, amount, slippage, wallet);
  const legASteps = tagLast(legA.steps, { fromToken: tokenSide.symbol, toToken: "MON", amountIn: Number(amount), amountOut: Number(legA.amountOut), provider: "Nad.Fun" });

  const legB = await buildCounterLeg(legA.amountOut, true);
  const legBSteps = tagLast(legB.steps, { fromToken: "MON", toToken: counterSide.symbol, amountIn: Number(legA.amountOut), amountOut: Number(legB.amountOut), provider: legB.provider });

  return [...legASteps, ...legBSteps];
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
    // A Nad.Fun-through-MON route never fits the single-venue executor
    // selection below (venueForProvider would otherwise mismatch the
    // composite "Uniswap v3 + Nad.Fun" string — see isMultiHopProvider's
    // own doc) — build both real legs directly instead.
    if (isMultiHopProvider(preview.route.provider)) {
      const multiSteps = await buildNadFunMultiHopSteps(req.action, inputSide, outputSide, preview.spend.amount, slippageFraction, wallet);
      return { ok: true, status: "ready", preview, steps: multiSteps };
    }

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
    // Tag the LAST step with settleLeg using the whole trade's own numbers —
    // uniform for every single-leg trade (the overwhelming majority), so
    // orchestrate.ts's execution loop never needs two different code paths
    // for "settle once at the end" vs. "settle per multi-hop leg": it's
    // always "settle whatever step says settleLeg". Identical settlement
    // behavior to before this field existed — one call, at the end, with
    // the whole trade's numbers.
    const tagged: TradeExecutionStep[] = steps.map((s, i, arr) =>
      i === arr.length - 1
        ? { ...s, settleLeg: { fromToken: preview.spend.token, toToken: preview.receive.token, amountIn: Number(preview.spend.amount), amountOut: Number(preview.receive.amount), provider: preview.route.provider } }
        : s,
    );
    return { ok: true, status: "ready", preview, steps: tagged };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't prepare that trade for signing." };
  }
}
