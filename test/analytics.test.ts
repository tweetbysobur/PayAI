import { describe, it, expect } from "vitest";
import {
  computeRevenue,
  computeCompliance,
  computeTrend,
  deriveCustomers,
  detectInsights,
  sumByToken,
  sumActivityByToken,
} from "@/lib/platform/analytics";
import type { TxLogEntry } from "@/lib/platform/types";

let idc = 0;
function tx(overrides: Partial<TxLogEntry> = {}): TxLogEntry {
  return {
    id: `tx_${idc++}`,
    at: Date.now(),
    decision: "executed",
    action: "send_payment",
    amount: 10,
    token: "USDC",
    recipient: "0xaaaa000000000000000000000000000000000001",
    riskScore: 5,
    compliance: "approved",
    summary: "Sent 10 USDC",
    ...overrides,
  };
}

describe("computeRevenue", () => {
  it("sums only settled payments and computes success rate", () => {
    const txs = [
      tx({ amount: 10 }),
      tx({ amount: 40 }),
      tx({ decision: "blocked", amount: 999 }),
    ];
    const r = computeRevenue(txs);
    expect(r.total).toBe(50);
    expect(r.settledCount).toBe(2);
    expect(r.failedCount).toBe(1);
    expect(r.successRate).toBeCloseTo(2 / 3, 5);
  });

  it("reports 100% success rate with no activity", () => {
    expect(computeRevenue([]).successRate).toBe(1);
  });
});

describe("computeCompliance", () => {
  it("tallies decisions and approval rate", () => {
    const txs = [
      tx({ decision: "executed" }),
      tx({ decision: "executed" }),
      tx({ decision: "needs_review" }),
      tx({ decision: "blocked" }),
    ];
    const c = computeCompliance(txs);
    expect(c.approved).toBe(2);
    expect(c.review).toBe(1);
    expect(c.rejected).toBe(1);
    // A "blocked" decision counts toward both rejected and blocked, so the
    // denominator is approved+review+rejected+blocked = 5.
    expect(c.approvalRate).toBeCloseTo(2 / 5, 5);
  });
});

describe("computeTrend", () => {
  it("returns one bucket per day for the window", () => {
    const trend = computeTrend([tx({ amount: 10 }), tx({ amount: 5 })], 7);
    expect(trend).toHaveLength(7);
    const today = trend[trend.length - 1];
    expect(today.count).toBe(2);
    expect(today.revenue).toBe(15);
  });
});

describe("deriveCustomers", () => {
  it("aggregates settled payments per recipient", () => {
    const who = "0xbbbb000000000000000000000000000000000002";
    const customers = deriveCustomers([
      tx({ recipient: who, amount: 10 }),
      tx({ recipient: who, amount: 30 }),
    ]);
    expect(customers).toHaveLength(1);
    expect(customers[0].totalPaid).toBe(40);
    expect(customers[0].paymentCount).toBe(2);
  });
});

describe("detectInsights", () => {
  it("reports healthy when nothing is anomalous", () => {
    const insights = detectInsights([tx({ amount: 10 }), tx({ amount: 12 })]);
    expect(insights.some((i) => i.id === "healthy")).toBe(true);
  });

  it("flags an elevated failure rate", () => {
    const txs = [
      tx({ decision: "executed" }),
      tx({ decision: "blocked" }),
      tx({ decision: "blocked" }),
      tx({ decision: "refused" }),
    ];
    const insights = detectInsights(txs);
    expect(insights.some((i) => i.id === "fail_rate")).toBe(true);
  });
});

/**
 * Amounts in different assets are not addable.
 *
 * The dashboard renders "Total revenue" as `${total} ${currency}` beside that
 * currency's logo. Summing every settled amount regardless of token and
 * labelling the result USDC reported a figure no transaction supports — a
 * 5 MON payment showed up as 5 USDC of revenue. The platform-wide view already
 * refused to do this (PlatformActivity.volumeByToken); the per-merchant view
 * did not.
 */
describe("computeRevenue — one currency at a time", () => {
  it("never adds amounts denominated in different tokens", () => {
    const r = computeRevenue([
      tx({ amount: 100, token: "USDC" }),
      tx({ amount: 100, token: "USDC" }),
      tx({ amount: 5, token: "MON" }),
    ]);
    expect(r.currency).toBe("USDC");
    expect(r.total, "the MON payment must not be counted as USDC").toBe(200);
  });

  it("reports every token's settled amount separately", () => {
    const r = computeRevenue([
      tx({ amount: 100, token: "USDC" }),
      tx({ amount: 5, token: "MON" }),
      tx({ amount: 2, token: "MON" }),
    ]);
    expect(r.byToken).toEqual({ USDC: 100, MON: 7 });
  });

  it("headlines the token the merchant actually settles in", () => {
    // A MON-only user must not be shown "0.00 USDC" and told that's their
    // revenue — the number is right and the label makes it a lie.
    const r = computeRevenue([
      tx({ amount: 3, token: "MON" }),
      tx({ amount: 4, token: "MON" }),
    ]);
    expect(r.currency).toBe("MON");
    expect(r.total).toBe(7);
  });

  it("excludes swaps, which move your own money rather than paying anyone", () => {
    const r = computeRevenue([
      tx({ amount: 100, token: "USDC" }),
      tx({ amount: 500, token: "USDC", action: "swap", summary: "Swap 500 USDC → MON" }),
    ]);
    expect(r.total).toBe(100);
    expect(r.settledCount).toBe(1);
  });

  it("keeps the trend chart in a single currency", () => {
    const trend = computeTrend(
      [tx({ amount: 100, token: "USDC" }), tx({ amount: 5, token: "MON" })],
      7,
      "USDC",
    );
    expect(trend.reduce((s, p) => s + p.revenue, 0)).toBe(100);
  });

  it("ranks top customers within one currency", () => {
    const big = "0xaaaa000000000000000000000000000000000001";
    const small = "0xbbbb000000000000000000000000000000000002";
    const customers = deriveCustomers(
      [
        tx({ amount: 50, token: "USDC", recipient: big }),
        tx({ amount: 900, token: "MON", recipient: small }),
        tx({ amount: 10, token: "USDC", recipient: small }),
      ],
      {},
      "USDC",
    );
    expect(customers[0].address).toBe(big);
    expect(customers[0].totalPaid).toBe(50);
    expect(customers.find((c) => c.address === small)?.totalPaid).toBe(10);
  });
});

/**
 * sumActivityByToken is deliberately a different figure from sumByToken/
 * revenue: "how much moved through the platform on any feature" rather than
 * "how much did someone actually get paid." A swap must count here even
 * though computeRevenue/sumByToken correctly refuse to count it as revenue.
 */
describe("sumActivityByToken — every feature, including swaps", () => {
  it("includes swaps, unlike sumByToken", () => {
    const txs = [
      tx({ amount: 100, token: "USDC" }),
      tx({ amount: 500, token: "USDC", action: "swap", summary: "Swap 500 USDC → MON" }),
    ];
    expect(sumByToken(txs)).toEqual({ USDC: 100 });
    expect(sumActivityByToken(txs)).toEqual({ USDC: 600 });
  });

  it("includes automation and bulk-distribution transactions the same as a manual send", () => {
    const activity = sumActivityByToken([
      tx({ amount: 10, token: "USDC", summary: "Sent 10 USDC" }),
      tx({ amount: 20, token: "USDC", summary: "Automation: payroll run" }),
      tx({ amount: 5, token: "USDC", summary: "Bulk distribution 1/3" }),
    ]);
    expect(activity).toEqual({ USDC: 35 });
  });

  it("excludes blocked, refused, and error transactions — only completed ones count", () => {
    const activity = sumActivityByToken([
      tx({ amount: 100, token: "USDC", decision: "executed" }),
      tx({ amount: 900, token: "USDC", decision: "blocked" }),
      tx({ amount: 900, token: "USDC", decision: "refused" }),
      tx({ amount: 900, token: "USDC", decision: "error" }),
    ]);
    expect(activity).toEqual({ USDC: 100 });
  });

  it("keeps tokens separate rather than blending amounts", () => {
    const activity = sumActivityByToken([
      tx({ amount: 100, token: "USDC" }),
      tx({ amount: 5, token: "MON", action: "swap" }),
    ]);
    expect(activity).toEqual({ USDC: 100, MON: 5 });
  });
});
