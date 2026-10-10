import { describe, it, expect } from "vitest";
import { calculateFee, buildReceipt, getTreasuryAddress } from "../lib/payment/feeEngine";

describe("calculateFee", () => {
  it("with no fee configured: estimates zero, net equals the input amount, and is labelled as an estimate (never 'free')", () => {
    for (const feature of ["send_payment", "swap", "wallet_automation", "reserved_funds"] as const) {
      const b = calculateFee(feature, 1000);
      expect(b.fee).toBe(0);
      expect(b.net).toBe(1000);
      expect(b.isFree).toBe(false);
      expect(b.status).toBe("estimated");
      expect(b.label).toBe("Not verified (no fee estimate configured)");
    }
  });

  it("treats invalid or non-positive amounts as zero, never negative", () => {
    expect(calculateFee("send_payment", -5).amount).toBe(0);
    expect(calculateFee("send_payment", NaN).amount).toBe(0);
    expect(calculateFee("send_payment", 0).amount).toBe(0);
  });

  it("never lets the fee exceed the amount, so net is never negative", () => {
    const b = calculateFee("swap", 50);
    expect(b.net).toBeGreaterThanOrEqual(0);
    expect(b.fee).toBeLessThanOrEqual(b.amount);
  });
});

describe("getTreasuryAddress", () => {
  it("is null until an address is explicitly configured", () => {
    expect(getTreasuryAddress()).toBeNull();
  });
});

describe("buildReceipt", () => {
  it("keeps USDC payments and MON gas as separate currencies in the total", () => {
    const r = buildReceipt({ feature: "send_payment", amount: 50, token: "USDC", gasFee: "0.002", status: "executed", txHash: "0xabc", explorerUrl: "https://monadexplorer.com/tx/0xabc" });
    expect(r.paymentAmount).toBe(50);
    expect(r.platformFee.isFree).toBe(false); // no evidence → an estimate, never "free"
    expect(r.gasFee).toBe("0.002");
    expect(r.totalCost).toBe("50 USDC + 0.002 MON gas");
    expect(r.status).toBe("executed");
    expect(r.txHash).toBe("0xabc");
  });

  it("sums payment + gas into one figure when the payment IS native MON", () => {
    const r = buildReceipt({ feature: "swap", amount: 10, token: "MON", gasFee: "0.002", status: "executed" });
    expect(r.totalCost).toBe("10.002 MON");
  });

  it("handles a missing gas fee without breaking the total", () => {
    const r = buildReceipt({ feature: "swap", amount: 10, token: "MON", status: "executed" });
    expect(r.totalCost).toBe("10 MON");
  });
});
