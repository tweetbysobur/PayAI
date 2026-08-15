import { NextRequest, NextResponse } from "next/server";
import { previewTrade, type TradeAction, type TradeAmountType } from "@/lib/monad/tradeQuote";

const ACTIONS: TradeAction[] = ["buy", "sell"];
const AMOUNT_TYPES: TradeAmountType[] = ["exact_input", "exact_output", "usd", "percentage", "balance_all"];

/**
 * POST /api/ask/trade — a real quote preview for a structured trade
 * request. STRICTLY PRE-EXECUTION: this never signs, approves, or moves
 * funds; it only reads live routes/quotes and reports them. See
 * lib/monad/tradeQuote.ts for the actual validation/quoting logic and
 * lib/ask/intent/orchestrate.ts's dispatchTrade for the only caller.
 *
 * Unauthenticated on purpose, same posture as /api/ask/token and
 * /api/ask/understand — nothing here needs a signer. `walletAddress` is
 * optional and only used for balance checks (percentage/balance_all
 * amounts, and rejecting an amount the wallet can't actually cover).
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: {
    action?: string; inputToken?: string; outputToken?: string;
    amount?: string; amountType?: string; slippage?: string | null; walletAddress?: string | null;
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

  try {
    const result = await previewTrade({
      action: body.action as TradeAction,
      inputToken: body.inputToken.trim(),
      outputToken: body.outputToken.trim(),
      amount: body.amount ?? "",
      amountType: body.amountType as TradeAmountType,
      slippage: body.slippage ?? null,
      walletAddress: body.walletAddress ?? null,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ ok: false, message: "Couldn't reach Monad to quote that trade. Try again in a moment." }, { status: 502 });
  }
}
