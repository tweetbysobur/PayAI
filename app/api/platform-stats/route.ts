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
 *
 * force-dynamic: this handler takes no request input (no cookies/headers/
 * searchParams), so Next.js would otherwise treat it as static and bake in
 * whatever the KV read returned at build time — serving that same stale
 * snapshot to every visitor forever instead of live totals.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { getPlatformActivity } = await import("@/lib/platform/analytics");
    const activity = await getPlatformActivity();
    const res = NextResponse.json(activity);
    // Landing page polling hits this from every visitor — cache briefly at the
    // edge so it's one KV read per window instead of one per request.
    res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    return res;
  } catch {
    return NextResponse.json({
      totalPayments: 0,
      volumeByToken: {},
      settledVolumeUsd: null,
      settledVolumeMon: null,
      unpricedSettledTokens: [],
      activityVolumeByToken: {},
      activityVolumeUsd: null,
      activityVolumeMon: null,
      unpricedTokens: [],
      monthlyVolumeUsd: [],
      compliance: { approved: 0, rejected: 0, review: 0, blocked: 0, approvalRate: 0 },
      trend: [],
      recent: [],
    });
  }
}
