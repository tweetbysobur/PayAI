import { NextResponse } from "next/server";
import { FEE_CONFIG } from "@/lib/payment/feeEngine";

/**
 * GET /api/fees — the current PayAI fee rate for every feature. Public,
 * unauthenticated: these are rates, not secrets, and a UI cannot show an
 * honest "Estimated Fees" line (the AI confirmation screen, the Automation/
 * Bulk Payment creation wizards) without knowing them BEFORE anything has
 * executed — there's no prior API response to read a receipt off yet.
 *
 * This is the ONLY sanctioned way client code learns the real fee rate.
 * lib/payment/feeEngine.ts (which reads process.env) is `server-only` and
 * cannot be imported from a client bundle at all; lib/payment/feeMath.ts's
 * pure `calculateFeeFromConfig`/`buildReceiptFromConfig` are safe for client
 * use ONLY once given a real FeeConfig — this endpoint is where that comes
 * from. See feeEngine.ts's doc comment for the bug this split fixes.
 */
// Rates can change (a config value in Vercel), so this must never be
// statically cached at build time.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(FEE_CONFIG);
}
