import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Phase 5 — deterministic native-MON split detection. Registry-gated,
 * chain-aware, version-pinned, never over a curated intent, and never with
 * LLM-invented recipients or amounts (recipients are literal 0x addresses from
 * the text; per-recipient amounts are an exact division of the stated total).
 * MONAD_NETWORK=mainnet so getChain() is 143 and the split action genuinely
 * registers against its canonical mainnet address.
 */

let priorNetwork: string | undefined;

beforeEach(async () => {
  priorNetwork = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(async () => {
  if (priorNetwork === undefined) delete process.env.MONAD_NETWORK;
  else process.env.MONAD_NETWORK = priorNetwork;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

describe("native-MON split detection", () => {
  it("'split 0.03 MON between A and B' resolves to split_payment with an exact equal split", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest(`split 0.03 MON between ${A} and ${B}`, null);
    expect(r.anthropic).toBe(false);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    expect(u.slots.protocolId).toBe("payai-settlement");
    expect(u.slots.actionId).toBe("split_payment");
    expect(u.slots.actionVersion).toBe("1.0.0"); // pinned from the registry
    const inputs = u.slots.actionInputs!;
    expect(inputs.token).toBe("0x0000000000000000000000000000000000000000");
    expect(inputs.recipient1.toLowerCase()).toBe(A.toLowerCase());
    expect(inputs.recipient2.toLowerCase()).toBe(B.toLowerCase());
    expect(inputs.amount1).toBe("0.015");
    expect(inputs.amount2).toBe("0.015");
    // The split is exact: the two amounts sum to the stated total.
    expect(Number(inputs.amount1) + Number(inputs.amount2)).toBeCloseTo(0.03, 12);
  });

  it("'distribute 0.06 MON to A, B and C' splits three ways", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest(`distribute 0.06 MON to ${A}, ${B} and ${C}`, null);
    const u = r.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    const inputs = u.slots.actionInputs!;
    expect(inputs.recipient3.toLowerCase()).toBe(C.toLowerCase());
    expect(inputs.amount1).toBe("0.02");
    expect(inputs.amount3).toBe("0.02");
  });

  it("a split with only ONE address is NOT a protocol action (falls through, never invents a second recipient)", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest(`split 0.03 MON to ${A}`, null);
    expect((r.understanding ?? r.fallback).kind).not.toBe("protocol_action");
  });

  it("a USDC split is not matched (native-only detector requires MON)", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest(`split 100 USDC between ${A} and ${B}`, null);
    expect((r.understanding ?? r.fallback).kind).not.toBe("protocol_action");
  });

  it("more than 3 recipients is not matched (bounded to the SDK schema)", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const D = "0x4444444444444444444444444444444444444444";
    const r = await routeRequest(`split 0.04 MON between ${A}, ${B}, ${C} and ${D}`, null);
    expect((r.understanding ?? r.fallback).kind).not.toBe("protocol_action");
  });

  it("a single-recipient payment ('send 10 MON to A') stays send_payment, never split", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest(`send 10 MON to ${A}`, null);
    expect((r.understanding ?? r.fallback).kind).toBe("send_payment");
  });
});
