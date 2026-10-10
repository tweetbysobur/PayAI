import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The CONFIGURED fee engine (env) charges nothing unless a fee env var is set,
 * and a user must always receive exactly the amount they approved. A zero
 * configured rate is only an estimate, though: the contracts charge their own
 * on-chain rate, so it is never labelled "free" (receipts call a fee free only
 * when the transaction itself proves it — see test/receipt-fees.test.ts).
 */
const FEATURES = ["send_payment", "swap", "wallet_automation", "reserved_funds"] as const;

describe("zero fees during beta", () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    // Nothing configured — the shape of a real beta deployment. FEE_CONFIG is
    // read once at module load, so the env must be clean before importing.
    for (const k of Object.keys(process.env)) if (k.startsWith("PAYAI_FEE_")) delete process.env[k];
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
    vi.resetModules();
  });

  it("charges nothing on any feature, and the recipient gets the full amount", async () => {
    const { calculateFee } = await import("@/lib/payment/feeEngine");
    for (const feature of FEATURES) {
      const f = calculateFee(feature, 250);
      expect(f.fee, `${feature} must charge no fee`).toBe(0);
      expect(f.net, `${feature} must pay out the full amount`).toBe(250);
      // A zero CONFIGURED rate is an estimate, not proof of a free payment.
      expect(f.status).toBe("estimated");
      expect(f.isFree).toBe(false);
    }
  });

  it("never says 'Free during Beta' for a zero configured rate — it says it isn't verified", async () => {
    const { calculateFee } = await import("@/lib/payment/feeEngine");
    const label = calculateFee("send_payment", 10).label;
    expect(label).not.toMatch(/free|beta/i);
    expect(label).toMatch(/not verified/i);
  });

  it("never skims a tiny payment through rounding", async () => {
    const { calculateFee } = await import("@/lib/payment/feeEngine");
    for (const amount of [0.000001, 0.01, 1, 999999]) {
      const f = calculateFee("send_payment", amount);
      expect(f.fee).toBe(0);
      expect(f.net).toBe(amount);
    }
  });

  it("a receipt without transaction evidence shows no fee figure, and doesn't claim one was free", async () => {
    const { buildReceipt } = await import("@/lib/payment/feeEngine");
    const r = buildReceipt({ feature: "send_payment", amount: 42, token: "USDC", status: "settled" });
    expect(r.platformFee.fee).toBe(0);
    expect(r.platformFee.isFree).toBe(false);
    expect(r.feeStatus).toBe("estimated");
    expect(r.paymentAmount).toBe(42);
  });

  it("still charges when a fee is deliberately configured", async () => {
    // Proves the zeros above are real configuration, not a hardcoded stub — if
    // this stopped charging, the fee engine would be broken rather than off,
    // and turning fees on after beta would silently do nothing.
    process.env.PAYAI_FEE_SEND_PAYMENT_BPS = "100"; // 1%
    vi.resetModules();
    const { calculateFee } = await import("@/lib/payment/feeEngine");
    const f = calculateFee("send_payment", 200);
    expect(f.isFree).toBe(false);
    expect(f.fee).toBeCloseTo(2, 10);
    // The fee is charged on top: the recipient still receives the full 200.
    expect(f.net).toBe(200);
  });
});
