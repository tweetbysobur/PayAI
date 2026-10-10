import { NextResponse } from "next/server";
import { FEE_CONFIG } from "@/lib/payment/feeEngine";
import { FEES_ABOUT } from "@/lib/payment/feeEstimates";

/**
 * GET /api/fees — PayAI's CONFIGURED fee estimates per feature. Public,
 * unauthenticated: these are rates, not secrets.
 *
 * What this is NOT: the rate PayAI actually charges. Every fee is computed
 * on-chain by the contract a transaction settles through, from that
 * contract's own feeBps() at execution (PayAIForwarderV2 for sends and
 * split payments, PayAITradeExecutor for executor-routed trades,
 * PaymentExecutorV2 / AutomationVaultV2 for automations). The confirmation a
 * user signs is prepared from those on-chain reads, not from this endpoint.
 * The values below come from env (lib/payment/feeEngine.ts) and can disagree
 * with a contract — e.g. a `swap` of 0 while the trade executor charges 25
 * bps — so the response says so in `about`, rather than this endpoint
 * silently claiming to be live. It deliberately does no chain reads (constant
 * work per request; see test/api-rate-limit-coverage.test.ts).
 *
 * The feature keys and their shape are unchanged (lib/ask/planCards.ts reads
 * `send_payment` for a labelled pre-quote ESTIMATE); `about` is additive.
 */
// Rates can change (a config value in Vercel), so this must never be
// statically cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { ...FEE_CONFIG, about: FEES_ABOUT },
    { headers: { "X-PayAI-Fee-Source": "configured-estimates; not-authoritative" } },
  );
}
