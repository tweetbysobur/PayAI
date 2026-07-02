import { describe, it, expect } from "vitest";
import {
  computeRevenue,
  computeCompliance,
  computeTrend,
  deriveCustomers,
  detectInsights,
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
