/**
 * Trade Quote & Validation — Step 3 of the PayAI Trading Engine. Turns a
 * structured trade request (action, input/output token, amount + how to
 * interpret it) into a real, validated quote preview. STRICTLY
 * PRE-EXECUTION: this module never builds an unsigned transaction, never
 * touches a wallet's signer, and is never called from anywhere that could
 * lead to one — see lib/ask/intent/orchestrate.ts's dispatchTrade, the only
 * caller, and components/ask/OperationCard.tsx's TradePreviewBody, whose
 * "Confirm trade" affordance is wired to nothing.
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
import { bestQuote, DEFAULT_SLIPPAGE, MAX_PRICE_IMPACT, MAX_SLIPPAGE, quoteUniswapDirect, resolveSwapSide } from "./swap";
import { GAS_RESERVE_MON, getTokenBalance } from "./balance";
import { getUsdPrice } from "./prices";

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
  /** Always [inputSymbol, outputSymbol] — a direct hop. Neither Uniswap's
   *  QuoterV2 call nor Kuru's simulate call used anywhere in this codebase
   *  does multi-hop routing, so a longer path is never fabricated here. */
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

/** The real quote: bestQuote() (symbol-safe, both sides verified) or
 *  quoteUniswapDirect() (address-based, at least one side arbitrary) — the
 *  exact same two primitives Step 2's market intelligence already uses. */
async function getTradeRoute(input: ResolvedTradeSide, output: ResolvedTradeSide, amount: string): Promise<RawRoute | null> {
  if (input.verified && output.verified) {
    try {
      const { provider, quote } = await bestQuote(input.symbol, output.symbol, Number(amount));
      return { provider: provider.name, amountOut: String(quote.amountOut), priceImpact: quote.priceImpact != null ? `${(quote.priceImpact * 100).toFixed(2)}%` : null };
    } catch {
      return null;
    }
  }
  const direct = await quoteUniswapDirect(input.address, input.decimals, output.address, output.decimals, amount);
  return direct ? { provider: "Uniswap v3", amountOut: direct.amountOut, priceImpact: direct.priceImpact } : null;
}

function fmt(n: number): string {
  return n.toFixed(n !== 0 && Math.abs(n) < 1 ? 8 : 4);
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

  const amountStr = String(amountResult.amount);
  const route = await getTradeRoute(inputSide, outputSide, amountStr);
  if (!route) return { ok: false, message: `No usable trading route found for ${inputSide.symbol} → ${outputSide.symbol} right now.` };

  const amountOutNum = Number(route.amountOut);
  const rate = amountResult.amount > 0 ? amountOutNum / amountResult.amount : 0;
  const minReceived = amountOutNum * (1 - slippageResult.slippage);
  const impactFraction = route.priceImpact ? parseFloat(route.priceImpact) / 100 : null;

  return {
    ok: true,
    action: req.action,
    spend: { amount: amountStr, token: inputSide.symbol },
    receive: { amount: route.amountOut, token: outputSide.symbol },
    rate: `1 ${inputSide.symbol} ≈ ${fmt(rate)} ${outputSide.symbol}`,
    minimumReceived: `${fmt(minReceived)} ${outputSide.symbol}`,
    priceImpact: route.priceImpact,
    highPriceImpact: impactFraction != null && impactFraction > MAX_PRICE_IMPACT,
    route: { provider: route.provider, path: [inputSide.symbol, outputSide.symbol] },
    slippage: `${(slippageResult.slippage * 100).toFixed(2)}%`,
    network: "Monad",
    quotedAt: Date.now(),
  };
}
