/**
 * payai/swap@1.0.0 — PayAI's existing MON ⇄ USDC trade, as an SDK action
 * the Intent Engine can plan and execute (Phase 2D).
 *
 * An ADAPTER over the existing trading engine, never a second one:
 *   - quote()  → lib/monad/tradeQuote.ts previewTrade() (same routing, same
 *                slippage limits, same executor fee source);
 *   - build()  → prepareTradeExecution(), handed the previewed snapshot so
 *                its own isMaterialChange() drift guard runs against exactly
 *                what the user saw (QUOTE_CHANGED otherwise);
 *   - confirm  → the executor's own TradeExecuted event, checked against the
 *                build's terms and wallet (settledTrade).
 *
 * v1 scope, refused otherwise:
 *   - pairs: MON → USDC and USDC → MON only — native MON, or PayAI's ONE
 *     configured stablecoin (getStablecoin());
 *   - exact input only: there is no amountOut input at all;
 *   - single hop, EXECUTOR-ONLY: every step must be the selected
 *     PayAITradeExecutor's trade call, or an EXACT ERC-20 approval whose
 *     spender is that executor. The engine may fall back to a direct router
 *     (e.g. a Kuru market the executor doesn't allowlist) — fine for the
 *     single-action trade flow, refused here. Nothing is silently rerouted.
 *     Layer B (lib/sdk/validate.ts) then re-checks every target and approval
 *     against the allowlist ([executor]).
 *
 * The build is decoded, not trusted: the executor calldata must carry
 * exactly the quoted tokenIn/tokenOut and the gross for the user's exact
 * amountIn (base units), with the matching native value; the approval must be
 * exactly approve(executor, gross). Inputs are tokenIn / tokenOut / amountIn
 * (base units) / slippageBps — nothing else (Layer A refuses unknown keys).
 *
 * Fee: charged ON TOP (lib/payment/feeOnTop.ts). `amountIn` is swapped in
 * full; the executor is handed gross = executorGross(amountIn, feeBps), and
 * its own floor(gross * feeBps / 10000) leaves exactly amountIn to swap. The
 * rate is read live via getExecutorFeeBps() and bound into the quote terms;
 * the confirmation requires the event's gross and fee to match the
 * BUILD-TIME rate exactly.
 *
 * Server-only. Never signs, broadcasts or holds a key.
 */
import "server-only";
import { decodeEventLog, decodeFunctionData, formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { getChain, getNetwork, getStablecoin } from "@/lib/monad/config";
import { DEFAULT_SLIPPAGE, ERC20_ABI, MAX_SLIPPAGE } from "@/lib/monad/swap";
import { normalizeDecimalString } from "@/lib/monad/verify";
import { prepareTradeExecution, previewTrade, type TradePreviewOk, type TradePreviewRequest } from "@/lib/monad/tradeQuote";
import { TRADE_EXECUTOR_ABI, applyExecutorFee, executorGross, getExecutorFeeBps, selectExecutor } from "@/lib/monad/tradeExecutor";
import { ActionInputError, ActionQuoteChangedError, inputString } from "@/lib/sdk/types";
import type {
  Action, ActionBuildContext, ActionInputs, ActionQuoteResult, ActionReceipt, ActionResultContext, SettledTrade, UnsignedActionStep, VerifiedOutputs,
} from "@/lib/sdk/types";

const PROTOCOL_ID = "payai";
const ACTION_ID = "swap";
const VERSION = "1.0.0";
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const UNITS_RE = /^[1-9][0-9]{0,77}$/;
const BPS_RE = /^[1-9][0-9]{0,4}$/;
/** The existing engine's limits, in basis points — never redefined. */
const MAX_SLIPPAGE_BPS = Math.round(MAX_SLIPPAGE * 10_000);
const DEFAULT_SLIPPAGE_BPS = Math.round(DEFAULT_SLIPPAGE * 10_000);
/** TradeExecuted venue ids (PayAITradeExecutor V1/V2: VENUE_UNISWAP, VENUE_KURU). */
const VENUES: Record<number, string> = { 0: "Uniswap v3", 1: "Kuru" };

export class SwapInputError extends ActionInputError {}

const PAIR_ERROR = "Only MON → USDC and USDC → MON swaps are supported here.";
const EXECUTOR_ONLY = "This swap can't be routed through PayAI's trade executor right now, so it isn't offered here.";

interface Side { isNative: boolean; symbol: string; decimals: number; /** Executor convention: address(0) for MON. */ address: Address }

function monSide(): Side {
  return { isNative: true, symbol: "MON", decimals: getChain().nativeCurrency.decimals, address: NATIVE };
}

function usdcSide(): Side {
  const u = getStablecoin();
  return { isNative: false, symbol: u.symbol, decimals: u.decimals, address: getAddress(u.address) };
}

/** Native MON (empty or the zero address), or the ONE configured stablecoin. */
function side(raw: string): Side {
  const t = raw.trim();
  if (!t || t.toLowerCase() === NATIVE) return monSide();
  const u = usdcSide();
  if (!isAddress(t, { strict: false }) || t.toLowerCase() !== u.address.toLowerCase()) throw new SwapInputError(PAIR_ERROR);
  return u;
}

interface Parsed { tokenIn: Side; tokenOut: Side; amountIn: bigint; slippageBps: number }

function parse(inputs: ActionInputs): Parsed {
  if (!inputString(inputs, "tokenOut").trim()) throw new SwapInputError("Choose the token to receive.");
  const tokenIn = side(inputString(inputs, "tokenIn"));
  const tokenOut = side(inputString(inputs, "tokenOut"));
  if (tokenIn.isNative === tokenOut.isNative) throw new SwapInputError(PAIR_ERROR);
  const a = inputString(inputs, "amountIn").trim();
  if (!UNITS_RE.test(a)) throw new SwapInputError("The amount must be a positive whole number of base units.");
  const s = inputString(inputs, "slippageBps").trim();
  if (s && (!BPS_RE.test(s) || Number(s) > MAX_SLIPPAGE_BPS)) {
    throw new SwapInputError(`Slippage must be a whole number of basis points from 1 to ${MAX_SLIPPAGE_BPS}.`);
  }
  return { tokenIn, tokenOut, amountIn: BigInt(a), slippageBps: s ? Number(s) : DEFAULT_SLIPPAGE_BPS };
}

/** The existing engine's request for this exact-input trade. */
function tradeRequest(p: Parsed, wallet: string | null): TradePreviewRequest {
  return {
    // The engine's convention: spending MON is a "sell", acquiring MON a "buy".
    action: p.tokenIn.isNative ? "sell" : "buy",
    inputToken: p.tokenIn.isNative ? "MON" : p.tokenIn.address,
    outputToken: p.tokenOut.isNative ? "MON" : p.tokenOut.address,
    amount: formatUnits(p.amountIn, p.tokenIn.decimals),
    amountType: "exact_input",
    slippage: String(p.slippageBps / 100),
    walletAddress: wallet,
  };
}

/** A preview this action can execute: single hop, executor-routed, for the
 *  user's EXACT amount (the engine works in decimals; anything it would
 *  round is refused rather than traded at a different amount). */
function requireExecutable(pv: TradePreviewOk, p: Parsed) {
  if (pv.route.path.length !== 2 || !pv.fee) throw new SwapInputError(EXECUTOR_ONLY);
  if (!/uniswap/i.test(pv.route.provider) && pv.route.provider !== "Kuru") throw new SwapInputError(EXECUTOR_ONLY);
  let quoted: bigint;
  try {
    quoted = parseUnits(normalizeDecimalString(pv.spend.amount, p.tokenIn.decimals), p.tokenIn.decimals);
  } catch {
    quoted = -1n;
  }
  if (quoted !== p.amountIn) throw new SwapInputError("That amount can't be traded exactly — use fewer significant digits.");
}

function termsOf(p: Parsed, executor: Address, feeBps: number) {
  return {
    executor: executor.toLowerCase(),
    feeBps: String(feeBps),
    tokenIn: p.tokenIn.address.toLowerCase(),
    tokenOut: p.tokenOut.address.toLowerCase(),
    amountIn: p.amountIn.toString(),
    slippageBps: String(p.slippageBps),
  };
}

/** Executor-only, exact-plan check on what the engine built. Every step is
 *  decoded; anything else — a router, another executor, a different amount
 *  or token, an approval to anyone but the executor — refuses the build. */
function executorSteps(
  steps: readonly { kind: string; label: string; tx: { to: string; data: string; value: string } }[],
  p: Parsed, executor: Address, feeBps: number,
): UnsignedActionStep[] {
  const ex = executor.toLowerCase();
  // What the executor must be handed: amountIn plus the fee on top.
  const want = executorGross(p.amountIn, feeBps).gross;
  // At most [exact approve, trade] for an ERC-20 input; exactly [trade] for MON.
  if (steps.length === 0 || steps.length > (p.tokenIn.isNative ? 1 : 2)) throw new SwapInputError(EXECUTOR_ONLY);
  const out: UnsignedActionStep[] = [];
  const valueOf = (v: string) => {
    try {
      return BigInt(v || "0");
    } catch {
      throw new SwapInputError(EXECUTOR_ONLY);
    }
  };
  steps.forEach((s, i) => {
    const last = i === steps.length - 1;
    if (!isAddress(s.tx.to, { strict: false }) || !/^0x[0-9a-fA-F]*$/.test(s.tx.data)) throw new SwapInputError(EXECUTOR_ONLY);
    const value = valueOf(s.tx.value);
    if (!last) {
      // The only step before the trade: the EXACT approval of the input token to the executor.
      if (s.kind !== "approve" || p.tokenIn.isNative || s.tx.to.toLowerCase() !== p.tokenIn.address.toLowerCase() || value !== 0n) {
        throw new SwapInputError(EXECUTOR_ONLY);
      }
      let call;
      try {
        call = decodeFunctionData({ abi: ERC20_ABI, data: s.tx.data as `0x${string}` });
      } catch {
        throw new SwapInputError(EXECUTOR_ONLY);
      }
      const [spender, amount] = (call.args ?? []) as unknown as [string, bigint];
      if (call.functionName !== "approve" || spender.toLowerCase() !== ex || amount !== want) throw new SwapInputError(EXECUTOR_ONLY);
      out.push({
        kind: "approve", label: s.label,
        tx: { to: getAddress(s.tx.to), data: s.tx.data as `0x${string}`, value: "0" },
        approval: { token: p.tokenIn.address, spender: executor, amount: want.toString() },
      });
      return;
    }
    if (s.tx.to.toLowerCase() !== ex) throw new SwapInputError(EXECUTOR_ONLY);
    let call;
    try {
      call = decodeFunctionData({ abi: TRADE_EXECUTOR_ABI, data: s.tx.data as `0x${string}` });
    } catch {
      throw new SwapInputError(EXECUTOR_ONLY);
    }
    let tokenIn: string;
    let tokenOut: string;
    let gross: bigint;
    if (call.functionName === "tradeUniswapExactInput") {
      [tokenIn, tokenOut, , gross] = call.args as unknown as [string, string, number, bigint];
    } else if (call.functionName === "tradeKuruExactInput") {
      [, , tokenIn, tokenOut, , gross] = call.args as unknown as [string, boolean, string, string, bigint, bigint];
    } else {
      throw new SwapInputError(EXECUTOR_ONLY);
    }
    if (tokenIn.toLowerCase() !== p.tokenIn.address.toLowerCase() || tokenOut.toLowerCase() !== p.tokenOut.address.toLowerCase() || gross !== want) {
      throw new SwapInputError("The prepared trade doesn't match your preview — request a fresh preview.");
    }
    if (value !== (p.tokenIn.isNative ? want : 0n)) throw new SwapInputError(EXECUTOR_ONLY);
    out.push({ kind: "action", label: s.label, tx: { to: executor, data: s.tx.data as `0x${string}`, value: value.toString() } });
  });
  if (out.length === 0 || out[out.length - 1].kind !== "action") throw new SwapInputError(EXECUTOR_ONLY);
  return out;
}

/** The one TradeExecuted the build's executor emitted, checked against the
 *  build's terms and wallet. Null when absent, ambiguous or mismatched. */
function verifiedTrade(receipt: ActionReceipt, rctx?: ActionResultContext): SettledTrade | null {
  if (receipt.status !== "success") return null;
  const t = rctx?.terms;
  const wallet = rctx?.wallet?.toLowerCase();
  if (!t || !wallet || !t.executor || !t.tokenIn || !t.tokenOut || !UNITS_RE.test(t.amountIn ?? "")) return null;
  const feeBps = Number(t.feeBps);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100) return null;

  const events: { user: string; venue: number; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint; feeAmount: bigint }[] = [];
  for (const log of receipt.logs) {
    // Only the build's own executor counts — another executor's event, or a
    // token's Transfer log, is never a substitute.
    if (log.address.toLowerCase() !== t.executor) continue;
    try {
      const ev = decodeEventLog({ abi: TRADE_EXECUTOR_ABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (ev.eventName !== "TradeExecuted") continue;
      const a = ev.args as unknown as { user: string; venue: number; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint; feeAmount: bigint };
      events.push({ ...a, venue: Number(a.venue) });
    } catch {
      // not a TradeExecuted
    }
  }
  if (events.length !== 1) return null;
  const e = events[0];
  // BUILD-TIME rate, never re-read here: the gross for amountIn with the fee
  // on top, and the executor's own fee on that gross.
  let gross: bigint;
  try {
    gross = executorGross(BigInt(t.amountIn), feeBps).gross;
  } catch {
    return null;
  }
  const expectedFee = applyExecutorFee(gross, feeBps).feeWei;
  const provider = VENUES[e.venue];
  if (
    e.user.toLowerCase() !== wallet ||
    e.tokenIn.toLowerCase() !== t.tokenIn || e.tokenOut.toLowerCase() !== t.tokenOut ||
    e.amountIn !== gross || e.feeAmount !== expectedFee || e.amountOut <= 0n || !provider
  ) return null;

  let sIn: Side;
  let sOut: Side;
  try {
    sIn = side(t.tokenIn);
    sOut = side(t.tokenOut);
  } catch {
    return null;
  }
  return {
    tokenIn: sIn.address, tokenOut: sOut.address, amountIn: e.amountIn, amountOut: e.amountOut, fee: e.feeAmount,
    symbolIn: sIn.symbol, symbolOut: sOut.symbol, decimalsIn: sIn.decimals, decimalsOut: sOut.decimals, provider,
  };
}

function swapAction(executor: Address, chainId: number): Action {
  return {
    protocolId: PROTOCOL_ID, actionId: ACTION_ID, version: VERSION,
    name: "Swap", description: "Swap MON ⇄ USDC through PayAI's trading engine and trade executor.",
    chainId, allowedTargets: [executor],
    historyAction: "trade",
    inputSchema: {
      // Optional: absent/zero sentinel = native MON; otherwise PayAI's stablecoin.
      tokenIn: { type: "token", required: false, description: "Token to spend: MON (leave empty) or USDC" },
      tokenOut: { type: "token", required: true, description: "Token to receive: USDC, or MON (the zero address)" },
      amountIn: { type: "units", required: true, description: "Exact amount to swap, in tokenIn's base units (PayAI's fee is added on top)" },
      slippageBps: { type: "number", required: false, description: "Slippage tolerance in basis points (default: the engine's 0.5%)" },
    },
    // Confirmed outputs, from the executor's own TradeExecuted (settledTrade).
    // Whether a later node may BIND one is the Intent IR's call: only an
    // output provably in an ERC-20 is bindable (NATIVE_OUTPUT_NOT_BINDABLE),
    // so MON → USDC's amountOut binds; USDC → MON's doesn't.
    outputs: {
      amountOut: { type: "units", description: "Confirmed amount of tokenOut received", denominatedIn: { input: "tokenOut" } },
      tokenOut: { type: "token", description: "The token received", denominatedIn: { input: "tokenOut" } },
      fee: { type: "units", description: "The PayAI platform fee, in tokenIn", denominatedIn: { input: "tokenIn" } },
    },

    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const p = parse(inputs);
      const feeBps = await getExecutorFeeBps(executor);
      const pv = await previewTrade(tradeRequest(p, null));
      if (!pv.ok) throw new SwapInputError(pv.message);
      requireExecutable(pv, p);
      return {
        summary: `Swap ${pv.spend.amount} ${p.tokenIn.symbol} for about ${pv.receive.amount} ${p.tokenOut.symbol}`,
        details: {
          "you swap": `${pv.spend.amount} ${p.tokenIn.symbol}`,
          "you receive (est.)": `${pv.receive.amount} ${p.tokenOut.symbol}`,
          "minimum received": pv.minimumReceived,
          "PayAI fee": `${pv.fee!.amount} ${pv.fee!.token} (${pv.fee!.percent}, on top)`,
          "total from your balance": `${pv.fee!.total} ${pv.fee!.token}`,
          route: pv.route.provider,
          slippage: pv.slippage,
          ...(pv.priceImpact ? { "price impact": `${pv.priceImpact}${pv.highPriceImpact ? " (high)" : ""}` } : {}),
        },
        quotedAt: pv.quotedAt,
        terms: termsOf(p, executor, feeBps),
        // What the drift guard compares the build-time quote against.
        snapshot: { receiveAmount: pv.receive.amount, provider: pv.route.provider },
      };
    },

    async build(inputs: ActionInputs, quote: ActionQuoteResult, ctx?: ActionBuildContext): Promise<UnsignedActionStep[]> {
      const p = parse(inputs);
      const feeBps = Number(quote.terms?.feeBps);
      if (!Number.isInteger(feeBps)) throw new SwapInputError("This swap has no valid fee terms — request a fresh preview.");
      const expected = termsOf(p, executor, feeBps);
      for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
        if (quote.terms?.[k] !== expected[k]) throw new SwapInputError("This swap's terms don't match its inputs — request a fresh preview.");
      }
      if (!ctx?.wallet) throw new SwapInputError("Connect your wallet to swap.");
      const prev = ctx.preview;
      if (!prev?.receiveAmount || !prev.provider) throw new SwapInputError("A fresh preview is required before this swap can be built.");
      // The existing engine re-quotes and applies its own drift guard
      // (isMaterialChange) against exactly the previewed snapshot.
      const r = await prepareTradeExecution(tradeRequest(p, ctx.wallet), { receiveAmount: prev.receiveAmount, provider: prev.provider });
      if (!r.ok) throw new SwapInputError(r.message);
      if (r.status === "changed") {
        throw new ActionQuoteChangedError(`The price moved since your preview (now about ${r.preview.receive.amount} ${p.tokenOut.symbol}). Request a fresh preview.`);
      }
      requireExecutable(r.preview, p);
      return executorSteps(r.steps, p, executor, feeBps);
    },

    async parseResult(receipt: ActionReceipt, rctx?: ActionResultContext): Promise<Readonly<Record<string, string>>> {
      const s = verifiedTrade(receipt, rctx);
      if (!s) return { status: receipt.status };
      const f = (u: bigint, symbol: string, decimals: number) => `${formatUnits(u, decimals)} ${symbol}`;
      return {
        status: receipt.status,
        "you paid": f(s.amountIn, s.symbolIn, s.decimalsIn),
        "you received": f(s.amountOut, s.symbolOut, s.decimalsOut),
        "platform fee": f(s.fee, s.symbolIn, s.decimalsIn),
        route: s.provider,
        transaction: receipt.txHash,
      };
    },

    async settledTrade(receipt: ActionReceipt, rctx?: ActionResultContext): Promise<SettledTrade | null> {
      return verifiedTrade(receipt, rctx);
    },

    // Machine-readable outputs from the SAME strict verification: every value
    // is the verified TradeExecuted's own (amountOut, fee) and its tokens are
    // the event's, which verifiedTrade already matched to the build's terms.
    // Unverifiable → null; never a preview, client or Transfer-log value.
    async confirmedOutputs(receipt: ActionReceipt, rctx?: ActionResultContext): Promise<VerifiedOutputs | null> {
      const s = verifiedTrade(receipt, rctx);
      if (!s) return null;
      const tokenIn = s.tokenIn.toLowerCase();
      const tokenOut = s.tokenOut.toLowerCase();
      return {
        outputs: {
          amountOut: { verified: true, type: "units", value: s.amountOut.toString(), token: tokenOut },
          tokenOut: { verified: true, type: "token", value: tokenOut },
          fee: { verified: true, type: "units", value: s.fee.toString(), token: tokenIn },
        },
        denominations: { tokenIn, tokenOut },
      };
    },
  };
}

/**
 * The swap action on the active chain, or null unless ALL of: Monad
 * mainnet (the trading engine's own requirement), a PayAI trade executor
 * selected for MON/USDC venues (configured AND enabled — the same gates the
 * existing trade flow uses), and a configured stablecoin. No executor, no
 * swap action: there is no direct-router path here.
 */
export function createSwapAction(): Action | null {
  if (getNetwork() !== "mainnet") return null;
  const executor = selectExecutor("uniswap");
  if (!executor || selectExecutor("kuru")?.toLowerCase() !== executor.toLowerCase()) return null;
  try {
    getStablecoin();
  } catch {
    return null;
  }
  return swapAction(getAddress(executor), getChain().id);
}
