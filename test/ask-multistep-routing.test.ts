import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripPoliteFraming, matchPlanRequest } from "@/lib/ask/planFastPath";
import { analyzeCompound, detectCompoundRequest } from "@/lib/ask/intent/compound";

/**
 * "Can you swap MON to USDC and send it to an address?" reached Ask's model
 * and was refused. The plan engine (swap, then a transfer of the swap's
 * verified output) already exists; the routing in front of it was too literal:
 *   - "Can you …?" / "please …" defeated the exact-shape grammar and the
 *     compound guard, so even a fully specified request fell through to the
 *     single-intent model, whose one-operation Understanding refused it;
 *   - a request missing its amount or recipient was refused instead of asked.
 * Execution is unchanged: plans are still created only by the Plan API, shown
 * for review, approved, and run by the existing runner.
 */

const ADDR = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";

describe("polite framing is removed — and nothing else", () => {
  it.each([
    ["Can you swap 5 MON to USDC and send it to bob.nad?", "swap 5 MON to USDC and send it to bob.nad"],
    ["could you please swap 5 MON to USDC, then send it to bob.nad", "swap 5 MON to USDC, then send it to bob.nad"],
    ["please swap 5 MON to USDC and send it to bob.nad", "swap 5 MON to USDC and send it to bob.nad"],
    ["I want to swap 5 MON to USDC and send it to bob.nad", "swap 5 MON to USDC and send it to bob.nad"],
    ["swap 5 MON to USDC and send it to bob.nad, please", "swap 5 MON to USDC and send it to bob.nad"],
    ["  Hey, can you   send 10 USDC to bob.nad?? ", "send 10 USDC to bob.nad"],
  ])("%s", (input, want) => {
    expect(stripPoliteFraming(input)).toBe(want);
  });

  it("never touches an amount, token or recipient", () => {
    for (const t of ["swap 5 MON to USDC and send it to please.nad", `send 10 USDC to ${ADDR}`, "send 1.5 MON to can"]) {
      expect(stripPoliteFraming(t)).toBe(t);
    }
  });
});

describe("a fully specified polite request is a plan, not a refusal", () => {
  it("is recognised as the swap-then-transfer plan once the framing is gone", () => {
    expect(matchPlanRequest("Can you swap 5 MON to USDC and send it to bob.nad?")).toBeNull(); // raw text: not the grammar
    expect(matchPlanRequest(stripPoliteFraming("Can you swap 5 MON to USDC and send it to bob.nad?"))).toBe("swap_send");
  });
  it("several actions and several transfers stay several actions", () => {
    expect(matchPlanRequest(stripPoliteFraming("could you send 1 MON to a and 2 MON to b?"))).toBe("multi");
    expect(matchPlanRequest(stripPoliteFraming("Please send 1 MON to alice.nad, then swap 5 USDC to MON"))).toBe("multi");
  });
  it("the compound guard now sees both actions (it used to see none and hand the message to the model)", () => {
    expect(analyzeCompound("Can you swap 5 MON to USDC and send it to bob.nad?")?.actions).toHaveLength(2);
    expect(analyzeCompound("can you send 10 USDC to alice.nad and 5 USDC to bob.nad?")?.actions).toHaveLength(2);
  });
  it("never reaches the model as a refusal: the guard answers, preparing nothing", () => {
    const u = detectCompoundRequest("Can you swap 5 MON to USDC and send it to bob.nad?");
    expect(u?.outcome).toBe("unsupported");
    expect(u && "reply" in u && u.reply).toMatch(/Nothing was prepared/);
  });
});

describe("a swap-then-send missing details asks for exactly those details", () => {
  const reply = (t: string) => {
    const u = detectCompoundRequest(t);
    expect(u && "capability" in u && u.capability).toBe("compound_incomplete");
    return u && "reply" in u ? u.reply : "";
  };

  it("the reported request: no amount, no recipient → asks for both, offers the plan", () => {
    const r = reply("can you swap mon to usdc and send to an address?");
    expect(r).toMatch(/how much MON to swap/);
    expect(r).toMatch(/who should receive it/);
    expect(r).toMatch(/swap 5 MON to USDC and send it to alice\.nad/);
    expect(r).toMatch(/review before anything runs/);
    expect(r).toMatch(/Nothing was prepared/);
    expect(r).not.toMatch(/can't chain|separately/i);
  });
  it("amount given, recipient missing → asks only for the recipient and keeps the amount", () => {
    const r = reply("swap 5 MON to USDC and send it to someone");
    expect(r).not.toMatch(/how much/);
    expect(r).toMatch(/who should receive it/);
    expect(r).toMatch(/swap 5 MON to USDC and send it to alice\.nad/);
  });
  it("recipient given, amount missing → asks only for the amount and keeps the recipient", () => {
    const r = reply("swap MON to USDC and send it to bob.nad");
    expect(r).toMatch(/how much MON to swap/);
    expect(r).not.toMatch(/who should receive/);
    expect(r).toMatch(/send it to bob\.nad/);
  });
  it("nothing missing → not a clarification (the plan path owns it)", () => {
    const u = detectCompoundRequest(`swap 5 MON to USDC and send it to ${ADDR}`);
    expect(u && "capability" in u ? u.capability : null).not.toBe("compound_incomplete");
  });
  it("a scheduled compound is still refused honestly, not turned into a plan", () => {
    const u = detectCompoundRequest("swap 5 MON to USDC and send it to bob.nad every Friday");
    expect(u && "capability" in u ? u.capability : null).toBe("compound_schedule");
  });
});

describe("single operations are untouched", () => {
  it("one action is not compound, polite or not", () => {
    for (const t of ["Can you send 10 USDC to bob.nad?", "please swap 5 MON to USDC", "send 10 USDC to bob.nad"]) {
      expect(analyzeCompound(t)).toBeNull();
      expect(detectCompoundRequest(t)).toBeNull();
    }
  });
  it("plain single transfer and swap still hit their fast paths", () => {
    expect(matchPlanRequest(stripPoliteFraming("Could you send 10 USDC to bob.nad?"))).toBe("transfer");
    expect(matchPlanRequest(stripPoliteFraming("can you swap 5 MON to USDC?"))).toBe("swap");
  });
});

describe("the engine behind it: order, dependency, and a failed first step (real planner + real validator)", () => {
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

  async function planFor(text: string) {
    const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
    const r = draftIntentGraph(text, { intentId: "intent_route_0001", wallet: WALLET, chainId: 143 });
    if (!r.ok) throw new Error(`refused: ${r.code}`);
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const v = validateIntentGraph(r.draft, { sessionWallet: WALLET, activeChainId: 143 });
    if (!v.ok) throw new Error(`invalid: ${v.error.code}`);
    const { planIntent } = await import("@/lib/plan/planner");
    return planIntent(v.value, { sessionWallet: WALLET });
  }

  it("the polite request becomes two steps in order, the transfer bound to the swap's own output", async () => {
    const plan = await planFor(stripPoliteFraming("Can you swap 5 MON to USDC and send it to bob.nad?"));
    expect(plan.steps.map((s) => s.nodeId)).toEqual(["n1", "n2"]);
    expect(plan.steps[0].outputsNeeded).toEqual(["amountOut"]);
    expect(plan.steps[1].expects).toEqual([expect.objectContaining({ node: "n1", output: "amountOut", token: USDC })]);
  });
  it("two independent transfers are two steps, each depending only on the one before", async () => {
    const plan = await planFor(stripPoliteFraming("could you send 1 MON to alice.nad and 2 MON to bob.nad?"));
    expect(plan.steps).toHaveLength(2);
  });
  it("a recipient that isn't one blocks the plan before anything is quoted", async () => {
    const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
    const r = draftIntentGraph("swap 5 MON to USDC and send it to not a recipient!", { intentId: "intent_route_0002", wallet: WALLET, chainId: 143 });
    expect(r.ok).toBe(false);
  });
  it("an unsupported token blocks the plan", async () => {
    const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
    const r = draftIntentGraph("swap 5 MON to DOGE and send it to bob.nad", { intentId: "intent_route_0003", wallet: WALLET, chainId: 143 });
    expect(r.ok).toBe(false);
  });
});
