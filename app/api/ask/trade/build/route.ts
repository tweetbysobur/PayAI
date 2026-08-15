import { NextRequest, NextResponse } from "next/server";
import { prepareTradeExecution, type TradeAction, type TradeAmountType } from "@/lib/monad/tradeQuote";

const ACTIONS: TradeAction[] = ["buy", "sell"];
const AMOUNT_TYPES: TradeAmountType[] = ["exact_input", "exact_output", "usd", "percentage", "balance_all"];

/**
 * POST /api/ask/trade/build — the ONLY place a trade's real unsigned
 * transaction steps are constructed. Called exactly once, from an explicit
 * "Confirm trade" click on an already-previewed card (see
 * lib/ask/intent/orchestrate.ts's executeTradeIntent) — never from a
 * preview render, never automatically.
 *
 * Re-quotes completely fresh server-side (see lib/monad/tradeQuote.ts's
 * prepareTradeExecution) rather than trusting anything the client says
 * about the current price; `previousQuote` is only a comparison point for
 * deciding whether the trade materially changed since the card was shown,
 * never an input to what gets built. The client never supplies — and this
 * route never accepts — a transaction target, calldata, or amount to sign;
 * those are always derived here from the request's token/amount fields.
 *
 * Requires walletAddress: unlike /api/ask/trade (a preview, can be
 * wallet-less), building real steps needs a real signer to build allowance
 * checks and swap recipients against.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: {
    action?: string; inputToken?: string; outputToken?: string;
    amount?: string; amountType?: string; slippage?: string | null; walletAddress?: string | null;
    previousQuote?: { receiveAmount?: string; provider?: string } | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }

  if (!body.action || !ACTIONS.includes(body.action as TradeAction)) {
    return NextResponse.json({ ok: false, message: "action must be 'buy' or 'sell'." }, { status: 400 });
  }
  if (!body.inputToken?.trim() || !body.outputToken?.trim()) {
    return NextResponse.json({ ok: false, message: "inputToken and outputToken are required." }, { status: 400 });
  }
  if (!body.amountType || !AMOUNT_TYPES.includes(body.amountType as TradeAmountType)) {
    return NextResponse.json({ ok: false, message: "amountType is required." }, { status: 400 });
  }
  if (!body.walletAddress?.trim()) {
    return NextResponse.json({ ok: false, message: "Connect your wallet to trade." }, { status: 400 });
  }

  const previousQuote = body.previousQuote?.receiveAmount != null && body.previousQuote?.provider != null
    ? { receiveAmount: body.previousQuote.receiveAmount, provider: body.previousQuote.provider }
    : null;

  try {
    const result = await prepareTradeExecution({
      action: body.action as TradeAction,
      inputToken: body.inputToken.trim(),
      outputToken: body.outputToken.trim(),
      amount: body.amount ?? "",
      amountType: body.amountType as TradeAmountType,
      slippage: body.slippage ?? null,
      walletAddress: body.walletAddress.trim(),
    }, previousQuote);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ ok: false, message: "Couldn't reach Monad to prepare that trade. Try again in a moment." }, { status: 502 });
  }
}
