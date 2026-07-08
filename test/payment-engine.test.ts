import { describe, it, expect } from "vitest";
import { runValidation, assessRisk } from "@/lib/payment/engine";
import type { PaymentRequest } from "@/lib/payment/types";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";

function req(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    action: "send_payment",
    amount: 50,
    token: "USDC",
    recipient: ADDR,
    purpose: null,
    network: "monad",
    ...overrides,
  };
}

describe("runValidation", () => {
  it("approves a clean, small transfer", () => {
    const r = runValidation(req());
    expect(r.status).toBe("approved");
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it("rejects a denylisted recipient (hard fail)", () => {
    const r = runValidation(req({ recipient: "sanctioned.nads" }));
    expect(r.status).toBe("rejected");
    expect(r.checks.find((c) => c.id === "sanctions")!.passed).toBe(false);
  });

  it("rejects an unsupported network (hard fail)", () => {
    // cast: exercising the guard for an out-of-set network
    const r = runValidation(req({ network: "solana" as PaymentRequest["network"] }));
    expect(r.status).toBe("rejected");
    expect(r.checks.find((c) => c.id === "network")!.passed).toBe(false);
  });

  it("flags a large undocumented transfer for review (soft fail)", () => {
    const r = runValidation(req({ amount: 300, purpose: null }));
    expect(r.status).toBe("review");
    expect(r.checks.find((c) => c.id === "travel_rule")!.passed).toBe(false);
  });

  it("approves a large transfer once a purpose is documented", () => {
    const r = runValidation(req({ amount: 300, purpose: "invoice #42" }));
    expect(r.status).toBe("approved");
  });
});

describe("assessRisk", () => {
  it("scores a large raw-address transfer as high risk", () => {
    const r = assessRisk(req({ amount: 600, recipient: ADDR, purpose: null }));
    expect(r.level).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(60);
  });

  it("scores a small named transfer as low risk", () => {
    const r = assessRisk(req({ amount: 20, recipient: "test.nads" }));
    expect(r.level).toBe("low");
    expect(r.score).toBeLessThan(30);
  });

  it("caps the score at 100", () => {
    const r = assessRisk(req({ amount: 100000, recipient: null }));
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("treats link creation as inherently low risk", () => {
    const r = assessRisk(req({ action: "create_payment_link", amount: 50, recipient: null }));
    expect(r.level).toBe("low");
  });
});
