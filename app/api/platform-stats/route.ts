import { NextResponse } from "next/server";

/**
 * GET /api/platform-stats — public, unauthenticated platform-wide totals for
 * the landing page: total payments processed and volume per asset, aggregated
 * across every tenant (the shared demo workspace + any registered merchants).
 *
 * Returns ONLY aggregate numbers — no payment list, no recipients, no wallet
 * addresses. This covers usage the on-chain PaymentExecutor stat misses: most
 * payments are direct wallet-to-wallet sends/swaps that settle without ever
 * calling that contract, so a public stat reading only the contract would
 * under-report real activity.
 */
export async function GET() {
  try {
    const { getPlatformActivity } = await import("@/lib/platform/analytics");
    const activity = await getPlatformActivity();
    return NextResponse.json(activity);
  } catch {
    return NextResponse.json({ totalPayments: 0, volumeByToken: {} });
  }
}
