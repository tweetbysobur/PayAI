import { describe, it, expect } from "vitest";
import { calculateFee } from "../lib/payment/fees";

describe("calculateFee", () => {
  it("charges zero fee by default — net always equals the input amount", () => {
    const b = calculateFee(1000);
    expect(b.fee).toBe(0);
    expect(b.net).toBe(1000);
    expect(b.feePct).toBe(0);
  });

  it("treats invalid or non-positive amounts as zero, never negative", () => {
    expect(calculateFee(-5).amount).toBe(0);
    expect(calculateFee(NaN).amount).toBe(0);
    expect(calculateFee(0).amount).toBe(0);
  });

  it("never lets the fee exceed the amount, so net is never negative", () => {
    const b = calculateFee(50);
    expect(b.net).toBeGreaterThanOrEqual(0);
    expect(b.fee).toBeLessThanOrEqual(b.amount);
  });
});
