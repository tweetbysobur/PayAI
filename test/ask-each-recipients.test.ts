import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandEachRequest, matchPlanRequest, toPlanText } from "@/lib/ask/planFastPath";

/**
 * "Send tokens to multiple recipients" in one sentence. An explicit "each"
 * ("send 5 USDC each to alice.nad and bob.nad") says every recipient gets the
 * stated amount, so it is written out as the exact multi-transfer form the
 * Plan API's grammar accepts — which stays the authority and shows every
 * transfer for review. Without "each" the amount could be a total or a share,
 * so nothing is guessed: that stays a question.
 */
const ADDR = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";

describe("expandEachRequest", () => {
  it.each([
    ["send 5 USDC each to alice.nad and bob.nad", "send 5 USDC to alice.nad, 5 USDC to bob.nad"],
    ["send 5 USDC to alice.nad and bob.nad each", "send 5 USDC to alice.nad, 5 USDC to bob.nad"],
    ["send 5 USDC to each of alice.nad and bob.nad", "send 5 USDC to alice.nad, 5 USDC to bob.nad"],
    ["pay alice.nad and bob.nad 5 USDC each", "send 5 USDC to alice.nad, 5 USDC to bob.nad"],
    ["send 2.5 MON each to alice.nad, bob.nad and carol", "send 2.5 MON to alice.nad, 2.5 MON to bob.nad, 2.5 MON to carol"],
    [`send 1 MON each to ${ADDR} & bob.nad`, `send 1 MON to ${ADDR}, 1 MON to bob.nad`],
  ])("%s", (input, want) => {
    expect(expandEachRequest(input)).toBe(want);
  });

  it.each([
    "send 5 USDC to alice.nad and bob.nad",            // no "each": total or share? never guessed
    "send 5 USDC each to alice.nad",                   // one recipient: nothing to expand
    "send 5 USDC each to alice.nad and alice.nad",     // the same recipient twice
    "send 5 USDC each to alice.nad and not a name!",   // not a recipient
    "send each to alice.nad and bob.nad",              // no amount
    "send 5 USDC each to alice.nad and bob.nad every Friday", // scheduling is not part of this
    "swap 5 USDC each to alice.nad and bob.nad",
    "send 5 USDC to alice.nad for each of my friends",
  ])("is left alone: %s", (input) => {
    expect(expandEachRequest(input)).toBeNull();
  });
});

describe("toPlanText", () => {
  it("strips polite framing, then expands 'each'", () => {
    expect(toPlanText("Can you send 5 USDC each to alice.nad and bob.nad?")).toBe("send 5 USDC to alice.nad, 5 USDC to bob.nad");
  });
  it("is just the stripped text otherwise", () => {
    expect(toPlanText("Please swap 5 MON to USDC and send it to bob.nad")).toBe("swap 5 MON to USDC and send it to bob.nad");
  });
  it("the expansion is recognised as a multi-transfer plan, one action per recipient", () => {
    expect(matchPlanRequest(toPlanText("send 5 USDC each to alice.nad and bob.nad"))).toBe("multi");
  });
});

describe("the Plan API's own grammar and validator accept the expansion (real adapter, real planner)", () => {
  const saved: Record<string, string | undefined> = {};
  const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED", "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR", "PAYAI_TRADE_EXECUTOR_ENABLED"];
  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.MONAD_NETWORK = "mainnet";
    process.env.MONAD_MAINNET_USDC = USDC;
    process.env.MONAD_MAINNET_PAYAI_FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
    process.env.PAYAI_FORWARDER_ENABLED = "true";
    process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
    process.env.PAYAI_TRADE_EXECUTOR_ENABLED = "true";
    const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
    const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    __resetRegistryForTests(); __resetBootstrapForTests(); ensureBuiltinsRegistered();
  });
  afterEach(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.restoreAllMocks();
  });

  it("each recipient becomes its own transfer of the stated amount, in the order written", async () => {
    const text = toPlanText(`send 5 USDC each to alice.nad, ${ADDR} and bob.nad`);
    const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
    const r = draftIntentGraph(text, { intentId: "intent_each_0001", wallet: WALLET, chainId: 143 });
    if (!r.ok) throw new Error(`adapter refused: ${r.code}`);
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const v = validateIntentGraph(r.draft, { sessionWallet: WALLET, activeChainId: 143 });
    if (!v.ok) throw new Error(`invalid: ${v.error.code}`);
    const { planIntent } = await import("@/lib/plan/planner");
    const plan = planIntent(v.value, { sessionWallet: WALLET });
    expect(plan.steps).toHaveLength(3);
    const inputs = r.draft.nodes.map((n) => n.inputs as Record<string, { value?: string; display?: string }>);
    expect(inputs.map((i) => i.amount.value)).toEqual(["5000000", "5000000", "5000000"]);
    expect(inputs.map((i) => i.recipient.display)).toEqual(["alice.nad", ADDR, "bob.nad"]);
    expect(r.draft.nodes.map((n) => n.dependsOn)).toEqual([[], ["n1"], ["n2"]]);
  });
});
