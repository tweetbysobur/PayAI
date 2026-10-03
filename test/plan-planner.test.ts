import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, ProtocolAdapter } from "@/lib/sdk/types";

/**
 * Phase 2C Stage 1: the deterministic Intent Planner core (lib/plan/planner.ts
 * + lib/plan/resolve.ts). Nothing here executes, signs or broadcasts. These
 * tests prove what a plan contains, what it refuses, and how bound values are
 * resolved from CONFIRMED outputs only.
 *
 * Real registry (MONAD_NETWORK=mainnet registers payai-settlement/
 * split_payment 2.0.0, which declares feePolicy on_top), plus TEST-ONLY
 * fixtures registered the same way as test/plan-intent-ir.test.ts. Fixtures'
 * quote/build/parseResult are spies that must never be called.
 */

const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const OTHER_WALLET = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const RECIPIENT = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const ALICE_ADDR = "0x1111111111111111111111111111111111111111";
const BOB_ADDR = "0x2222222222222222222222222222222222222222";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_UINT256 = (1n << 256n) - 1n;

const spies = { quote: vi.fn(), build: vi.fn(), parseResult: vi.fn() };
const neverCalled = (name: keyof typeof spies) => async (...a: unknown[]): Promise<never> => {
  spies[name](...a);
  throw new Error(`fixture: ${name} must not be called by the planner`);
};

function fixture(protocolId: string, action: Omit<Action, "protocolId" | "chainId" | "allowedTargets" | "quote" | "build" | "parseResult">): ProtocolAdapter {
  const target = "0x00000000000000000000000000000000000000f1" as const;
  return {
    protocolId, name: `${protocolId} (test fixture)`, chainId: 143, allowedTargets: [target],
    actions: [{
      ...action, protocolId, chainId: 143, allowedTargets: [target],
      quote: neverCalled("quote"), build: neverCalled("build"), parseResult: neverCalled("parseResult"),
    } as Action],
  };
}
const TRANSFER = fixture("payai", {
  actionId: "transfer", version: "1.0.0", name: "Transfer", description: "test fixture",
  inputSchema: {
    recipient: { type: "address", required: true, description: "to" },
    token: { type: "token", required: false, description: "token (empty = MON)" },
    amount: { type: "units", required: true, description: "amount" },
  },
});
const SWAP = fixture("payai-swap", {
  actionId: "swap", version: "1.0.0", name: "Swap", description: "test fixture",
  inputSchema: {
    tokenIn: { type: "token", required: false, description: "in (empty = MON)" },
    tokenOut: { type: "token", required: true, description: "out" },
    amountIn: { type: "units", required: true, description: "amount in" },
  },
  outputs: {
    amountOut: { type: "units", description: "confirmed amount received", denominatedIn: { input: "tokenOut" } },
    tokenOut: { type: "token", description: "token received", denominatedIn: { input: "tokenOut" } },
  },
});
const listSchema = {
  recipients: {
    type: "list" as const, required: true, minItems: 2, maxItems: 9, description: "who gets what",
    items: {
      recipient: { type: "address" as const, required: true, description: "to" },
      amount: { type: "units" as const, required: true, description: "amount" },
    },
  },
  token: { type: "token" as const, required: false, description: "token" },
};
/** An unrelated action that charges its fee on top — the planner must apply
 *  the fee-inclusive remainder from METADATA, whatever the action is called. */
const PAYOUT_ON_TOP = fixture("acme", { actionId: "payout", version: "3.1.0", name: "Payout", description: "test fixture", inputSchema: listSchema, feePolicy: { mode: "on_top" } });
/** Same name and shape as the real split, under another protocol, with NO fee
 *  policy — proves nothing keys off the name "split_payment". */
const SPLIT_LOOKALIKE = fixture("lookalike", { actionId: "split_payment", version: "2.0.0", name: "Split Payment", description: "test fixture", inputSchema: listSchema });
/** A fee-on-top action with a scalar amount (no list to define the fee base). */
const TIP_ON_TOP = fixture("acme-tip", {
  actionId: "tip", version: "1.0.0", name: "Tip", description: "test fixture", feePolicy: { mode: "on_top" },
  inputSchema: TRANSFER.actions[0].inputSchema,
});

let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  Object.values(spies).forEach((s) => s.mockClear());
  const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
  for (const p of [TRANSFER, SWAP, PAYOUT_ON_TOP, SPLIT_LOOKALIKE, TIP_ON_TOP]) registerProtocol(p);
});
afterEach(async () => {
  if (saved === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = saved;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

/* ── builders ───────────────────────────────────────────────────────────── */

type Ref = [string, string, string];
const T: Ref = ["payai", "transfer", "1.0.0"];
const S: Ref = ["payai-swap", "swap", "1.0.0"];
const SPLIT: Ref = ["payai-settlement", "split_payment", "2.0.0"];
const PAYOUT: Ref = ["acme", "payout", "3.1.0"];
const LOOKALIKE: Ref = ["lookalike", "split_payment", "2.0.0"];
const TIP: Ref = ["acme-tip", "tip", "1.0.0"];
const WRAP: Ref = ["wmon", "wrap", "1.0.0"];

const lit = (value: string) => ({ kind: "literal", value });
const out = (node: string, output: string) => ({ kind: "output", node, output });
const rem = (node: string, output: string, minus: string[]) => ({ kind: "remainder", node, output, minus });
const addr = (a: string) => ({ kind: "recipient", display: a, source: "address", address: a });
const payee = (name: string) => ({ kind: "recipient", display: name, source: "payee" });
const nad = (name: string) => ({ kind: "recipient", display: name, source: "nad" });

function node(nodeId: string, ref: Ref, inputs: Record<string, unknown>, dependsOn: string[] = []) {
  return {
    nodeId, ref: { protocolId: ref[0], actionId: ref[1], version: ref[2] }, inputs, dependsOn,
    validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
  };
}
function graph(nodes: unknown[], text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "intent_plan_0001", version: 1, chainId: 143, wallet: WALLET, nodes, status: "draft",
    source: { text, adapter: "deterministic", adapterVersion: "1" }, ...extra,
  };
}

const swapNode = (amountIn = "100000000000000000000") => node("n1", S, { tokenOut: lit(USDC), amountIn: lit(amountIn) });

const SEND_TEXT = `swap 100 MON to USDC and send the USDC to ${RECIPIENT}`;
const sendDraft = () => graph([
  swapNode(),
  node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "amountOut") }, ["n1"]),
], SEND_TEXT);

const SPLIT_TEXT = "swap 100 MON to USDC, send 20 USDC to Alice and the rest to Bob";
const splitDraft = (ref: Ref = SPLIT, alice = "20000000", minus = ["20000000"]) => graph([
  swapNode(),
  node("n2", ref, {
    token: lit(USDC),
    recipients: { kind: "list", items: [
      { recipient: payee("Alice"), amount: lit(alice) },
      { recipient: payee("Bob"), amount: rem("n1", "amountOut", minus) },
    ] },
  }, ["n1"]),
], SPLIT_TEXT);

const restDraft = (minus = ["20000000"]) => graph([
  swapNode(),
  node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: rem("n1", "amountOut", minus) }, ["n1"]),
], `swap 100 MON to USDC and send all but 20 USDC to ${RECIPIENT}`);

async function lib() {
  const v = await import("@/lib/plan/validate");
  const p = await import("@/lib/plan/planner");
  const r = await import("@/lib/plan/resolve");
  const e = await import("@/lib/plan/errors");
  return { ...v, ...p, ...r, ...e };
}
async function validated(raw: unknown) {
  const { validateIntentGraph } = await lib();
  const res = validateIntentGraph(raw, { sessionWallet: WALLET, activeChainId: 143 });
  if (!res.ok) throw new Error(`expected valid, got ${JSON.stringify(res.error)}`);
  return res.value;
}
async function validationCode(raw: unknown) {
  const { validateIntentGraph } = await lib();
  const res = validateIntentGraph(raw, { sessionWallet: WALLET, activeChainId: 143 });
  return res.ok ? "OK" : res.error.code;
}
async function planned(raw: unknown) {
  const g = await validated(raw);
  const { planIntent } = await lib();
  return { g, plan: planIntent(g, { sessionWallet: WALLET }) };
}

type Confirmed = Record<string, Record<string, unknown>>;
const units = (value: string, token = USDC, extra: Record<string, unknown> = {}) => ({ verified: true, type: "units", value, token, ...extra });
const confirmedSwap = (amountOut: string, o: Partial<{ token: string; tokenOut: unknown }> = {}): Confirmed => ({
  n1: { amountOut: units(amountOut, o.token ?? USDC), tokenOut: o.tokenOut ?? { verified: true, type: "token", value: USDC } },
});

async function resolve(raw: unknown, confirmed: Confirmed, opts: Partial<{ nodeId: string; recipients: Record<string, string>; feeBps: unknown; sessionWallet: string }> = {}) {
  const { plan, g } = await planned(raw);
  const { resolveStepInputs } = await lib();
  // Scalar fields resolve to strings; lists are read through items().
  return resolveStepInputs({
    plan, graph: g, nodeId: opts.nodeId ?? "n2", sessionWallet: opts.sessionWallet ?? WALLET,
    confirmed: confirmed as never, recipients: opts.recipients, feeBps: opts.feeBps as number | undefined,
  }) as Readonly<Record<string, string>>;
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? `THREW:${(e as Error).message}`; }
  return "NO_ERROR";
}
async function resolveCode(...a: Parameters<typeof resolve>) {
  try { await resolve(...a); } catch (e) { return (e as { code?: string }).code ?? `THREW:${(e as Error).message}`; }
  return "NO_ERROR";
}

const PINS = { "payee:alice": ALICE_ADDR, "payee:bob": BOB_ADDR };
const items = (r: unknown) => (r as { recipients: Record<string, string>[] }).recipients;

/* ── GRAPH INTEGRITY ────────────────────────────────────────────────────── */

describe("graph integrity", () => {
  it("1. a validated graph is accepted and planned", async () => {
    const { g, plan } = await planned(sendDraft());
    const { isValidatedIntentGraph, isExecutionPlan } = await lib();
    expect(isValidatedIntentGraph(g)).toBe(true);
    expect(isExecutionPlan(plan)).toBe(true);
    expect(plan.steps.map((s) => s.nodeId)).toEqual(["n1", "n2"]);
  });

  it("2. a hand-created graph is refused — even an exact structural copy of a validated one", async () => {
    const g = await validated(sendDraft());
    const { planIntent, isValidatedIntentGraph, assertPlanMatchesGraph } = await lib();
    const copy = JSON.parse(JSON.stringify(g));
    expect(isValidatedIntentGraph(copy)).toBe(false);
    expect(codeOf(() => planIntent(copy, { sessionWallet: WALLET }))).toBe("UNVALIDATED_GRAPH");
    expect(codeOf(() => planIntent({ ...g }, { sessionWallet: WALLET }))).toBe("UNVALIDATED_GRAPH");
    expect(codeOf(() => planIntent(sendDraft() as never, { sessionWallet: WALLET }))).toBe("UNVALIDATED_GRAPH");
    expect(codeOf(() => planIntent(null as never, { sessionWallet: WALLET }))).toBe("UNVALIDATED_GRAPH");
    const plan = planIntent(g, { sessionWallet: WALLET });
    expect(codeOf(() => assertPlanMatchesGraph(plan, copy))).toBe("UNVALIDATED_GRAPH");
  });

  it("3. graph mutation: the validated graph is frozen, the caller's draft is isolated, and a changed graph is GRAPH_MUTATION", async () => {
    const draft = sendDraft();
    const { g, plan } = await planned(draft);
    const { graphHash, assertPlanMatchesGraph } = await lib();
    const before = graphHash(g);
    expect(Object.isFrozen(g)).toBe(true);
    expect(() => { (g as { id: string }).id = "intent_other_01"; }).toThrow(TypeError);
    expect(() => { (g as { wallet: string }).wallet = OTHER_WALLET; }).toThrow(TypeError);
    // Mutating the draft afterwards changes nothing that was validated.
    draft.id = "intent_other_01";
    (draft.nodes[1] as { inputs: Record<string, unknown> }).inputs.amount = lit("1");
    expect(graphHash(g)).toBe(before);
    expect(g.id).toBe("intent_plan_0001");
    expect(() => assertPlanMatchesGraph(plan, g)).not.toThrow();
    // The mutated draft, validated again, is a different graph.
    const g2 = await validated(draft);
    expect(codeOf(() => assertPlanMatchesGraph(plan, g2))).toBe("GRAPH_MUTATION");
  });

  it("4. nested mutation: nodes, refs and inputs are frozen; a nested change is GRAPH_MUTATION", async () => {
    const { g, plan } = await planned(sendDraft());
    expect(() => { (g.nodes as unknown[]).push({}); }).toThrow(TypeError);
    expect(() => { (g.nodes[0].ref as { version: string }).version = "9.9.9"; }).toThrow(TypeError);
    expect(() => { (g.nodes[0].inputs.amountIn as { value: string }).value = "1"; }).toThrow(TypeError);
    expect(() => { (g.order as string[]).reverse(); }).toThrow(TypeError);
    expect(() => { (g.boundOutputs.n1.amountOut as { token: string }).token = WMON; }).toThrow(TypeError);
    const d = sendDraft();
    (d.nodes[0] as { inputs: Record<string, unknown> }).inputs.amountIn = lit("100000000000000000001");
    const { assertPlanMatchesGraph } = await lib();
    expect(codeOf(() => assertPlanMatchesGraph(plan, g))).toBe("NO_ERROR");
    const g2 = await validated(d);
    expect(codeOf(() => assertPlanMatchesGraph(plan, g2))).toBe("GRAPH_MUTATION");
  });

  it("5. input list mutation: list items are frozen and isolated; a changed list is GRAPH_MUTATION", async () => {
    const draft = splitDraft();
    const { g, plan } = await planned(draft);
    const list = g.nodes[1].inputs.recipients as { items: Record<string, { value?: string }>[] };
    expect(() => { (list.items as unknown[]).push({}); }).toThrow(TypeError);
    expect(() => { list.items[0].amount.value = "1"; }).toThrow(TypeError);
    // The draft's own list object isn't the validated one.
    const draftList = (draft.nodes[1] as { inputs: { recipients: { items: unknown[] } } }).inputs.recipients;
    expect(draftList.items).not.toBe(list.items);
    draftList.items.pop();
    expect(list.items).toHaveLength(2);
    const { assertPlanMatchesGraph } = await lib();
    const g2 = await validated(splitDraft(SPLIT, "30000000", ["30000000"]));
    expect(codeOf(() => assertPlanMatchesGraph(plan, g2))).toBe("GRAPH_MUTATION");
  });

  it("6. remainder minus mutation: the minus array is frozen; a different minus is GRAPH_MUTATION", async () => {
    const draft = splitDraft();
    const { g, plan } = await planned(draft);
    const bob = (g.nodes[1].inputs.recipients as { items: Record<string, { minus?: string[] }>[] }).items[1].amount;
    expect(() => { bob.minus!.push("1"); }).toThrow(TypeError);
    expect(() => { bob.minus![0] = "1"; }).toThrow(TypeError);
    ((draft.nodes[1] as { inputs: { recipients: { items: { amount: { minus?: string[] } }[] } } }).inputs.recipients.items[1].amount.minus!)[0] = "1";
    expect(bob.minus).toEqual(["20000000"]);
    const { assertPlanMatchesGraph } = await lib();
    const g2 = await validated(splitDraft(SPLIT, "20000000", ["10000000", "10000000"]));
    expect(codeOf(() => assertPlanMatchesGraph(plan, g2))).toBe("GRAPH_MUTATION");
  });

  it("7. dependency mutation: dependsOn is frozen; an added dependency is GRAPH_MUTATION", async () => {
    const text = "wrap 1 MON and wrap 2 MON";
    const a = node("a", WRAP, { amount: lit("1") });
    const b = node("b", WRAP, { amount: lit("2") });
    const { g, plan } = await planned(graph([a, b], text));
    expect(() => { (g.nodes[1].dependsOn as string[]).push("a"); }).toThrow(TypeError);
    const g2 = await validated(graph([a, { ...b, dependsOn: ["a"] }], text));
    const { assertPlanMatchesGraph, graphHash } = await lib();
    expect(graphHash(g2)).not.toBe(plan.graphHash);
    expect(codeOf(() => assertPlanMatchesGraph(plan, g2))).toBe("GRAPH_MUTATION");
  });

  it("8. source mutation: source is frozen; a different source text or adapter is GRAPH_MUTATION", async () => {
    const { g, plan } = await planned(sendDraft());
    expect(() => { (g.source as { text: string }).text = "x"; }).toThrow(TypeError);
    const { assertPlanMatchesGraph } = await lib();
    const d1 = sendDraft(); d1.source.text = `${SEND_TEXT} please`;
    const d2 = sendDraft(); d2.source.adapter = "llm";
    const d3 = sendDraft(); d3.source.adapterVersion = "2";
    for (const d of [d1, d2, d3]) {
      const g2 = await validated(d);
      expect(codeOf(() => assertPlanMatchesGraph(plan, g2))).toBe("GRAPH_MUTATION");
    }
  });
});

/* ── DETERMINISM ────────────────────────────────────────────────────────── */

describe("determinism", () => {
  it("9. node order is the validator's: producers first, ties in written order", async () => {
    const text = `swap 100 MON to USDC and send the USDC to ${RECIPIENT}`;
    const { plan } = await planned(graph([
      node("send", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("swap", "amountOut") }, ["swap"]),
      node("swap", S, { tokenOut: lit(USDC), amountIn: lit("100000000000000000000") }),
    ], text));
    expect(plan.steps.map((s) => s.nodeId)).toEqual(["swap", "send"]);
    const w = (id: string, amount: string) => node(id, WRAP, { amount: lit(amount) });
    const { g: g2, plan: p2 } = await planned(graph([w("c", "3"), w("a", "1"), w("b", "2")], "wrap 3, 1 and 2 MON"));
    expect(p2.steps.map((s) => s.nodeId)).toEqual(["c", "a", "b"]);
    expect(p2.steps.map((s) => s.nodeId)).toEqual([...g2.order]);
  });

  it("10. dependencies always precede dependents; invalid dependency structures never reach the planner", async () => {
    const text = "wrap 1, 2, 3 and 4 MON";
    const w = (id: string, deps: string[]) => node(id, WRAP, { amount: lit("1") }, deps);
    const { plan } = await planned(graph([w("d", ["c", "b"]), w("c", ["a"]), w("b", ["a"]), w("a", [])], text));
    expect(plan.steps.map((s) => s.nodeId)).toEqual(["a", "c", "b", "d"]);
    const seen = new Set<string>();
    for (const s of plan.steps) { for (const d of s.dependsOn) expect(seen.has(d)).toBe(true); seen.add(s.nodeId); }
    // Cycles, missing, duplicate and self dependencies are refused by the
    // validator, and the planner has no way to take an unvalidated graph.
    expect(await validationCode(graph([w("a", ["b"]), w("b", ["a"])], text))).toBe("CYCLE");
    expect(await validationCode(graph([w("a", ["zz"])], text))).toBe("UNKNOWN_DEPENDENCY");
    expect(await validationCode(graph([w("a", []), w("b", ["a", "a"])], text))).toBe("MALFORMED");
    expect(await validationCode(graph([w("a", ["a"])], text))).toBe("SELF_DEPENDENCY");
    expect(await validationCode(graph([w("a", []), w("b", []), w("c", []), w("d", []), w("e", [])], text))).toBe("NODE_COUNT");
    const { planIntent } = await lib();
    const forged = { ...(await validated(graph([w("a", []), w("b", ["a"])], text))), order: ["b", "a"] };
    expect(codeOf(() => planIntent(forged, { sessionWallet: WALLET }))).toBe("UNVALIDATED_GRAPH");
  });

  it("11. the graph hash (and planId) is stable for identical graphs, whatever the key order, and ignores runtime state", async () => {
    const { graphHash, canonicalize, planIntent } = await lib();
    const g1 = await validated(splitDraft());
    const reordered = JSON.parse(JSON.stringify(splitDraft()), (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v);
    const g2 = await validated(reordered);
    expect(g1).not.toBe(g2);
    expect(graphHash(g1)).toBe(graphHash(g2));
    expect(graphHash(g1)).toMatch(/^[0-9a-f]{64}$/);
    const p1 = planIntent(g1, { sessionWallet: WALLET });
    const p2 = planIntent(g2, { sessionWallet: WALLET });
    expect(p1.planId).toBe(p2.planId);
    expect(p1.planId).toMatch(/^plan_[0-9a-f]{32}$/);
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
    expect(canonicalize({ b: 1, a: [3, { d: 1, c: 2 }] })).toBe('{"a":[3,{"c":2,"d":1}],"b":1}');
    // Runtime state is excluded: progress never changes a graph's identity.
    const progressed = JSON.parse(JSON.stringify(g1));
    progressed.status = "running";
    progressed.nodes[0].execution = { state: "confirmed", txHash: `0x${"ab".repeat(32)}` };
    progressed.nodes[0].verification = { state: "verified", confirmed: { amountOut: "1" } };
    progressed.nodes[1].validation = { state: "invalid", code: "X" };
    progressed.feePolicies = {};
    progressed.boundOutputs = {};
    expect(graphHash(progressed)).toBe(graphHash(g1));
  });

  it("12. every meaningful change changes the hash", async () => {
    const { graphHash } = await lib();
    const base = graphHash(await validated(sendDraft()));
    const variants: unknown[] = [];
    const v = (f: (d: ReturnType<typeof sendDraft>) => void) => { const d = sendDraft(); f(d); variants.push(d); };
    v((d) => { d.id = "intent_plan_0002"; });
    v((d) => { d.source.text = `${SEND_TEXT}!`; });
    v((d) => { (d.nodes[0] as { inputs: Record<string, unknown> }).inputs.amountIn = lit("100000000000000000001"); });
    v((d) => { (d.nodes[0] as { inputs: Record<string, unknown> }).inputs.tokenOut = lit(WMON); (d.nodes[1] as { inputs: Record<string, unknown> }).inputs.token = lit(WMON); });
    v((d) => { (d.nodes[1] as { inputs: Record<string, unknown> }).inputs.amount = out("n1", "amountOut"); (d.nodes[0] as { nodeId: string }).nodeId = "n0"; (d.nodes[1] as { dependsOn: string[] }).dependsOn = ["n0"]; (d.nodes[1] as { inputs: Record<string, unknown> }).inputs.amount = out("n0", "amountOut"); });
    v((d) => { (d.nodes[1] as { inputs: Record<string, unknown> }).inputs.amount = rem("n1", "amountOut", ["1"]); });
    v((d) => { d.nodes.reverse(); });
    const hashes = new Set([base]);
    for (const d of variants) hashes.add(graphHash(await validated(d)));
    expect(hashes.size).toBe(variants.length + 1);
    // Wallet and chain are in the hash too (a validated graph can only carry
    // the session's, so this is checked on the serialization directly).
    const g = JSON.parse(JSON.stringify(await validated(sendDraft())));
    expect(graphHash({ ...g, wallet: OTHER_WALLET })).not.toBe(base);
    expect(graphHash({ ...g, chainId: 1 })).not.toBe(base);
    expect(graphHash({ ...g, version: 2 })).not.toBe(base);
    expect(graphHash({ ...g, order: [...g.order].reverse() })).not.toBe(base);
    expect(graphHash(g)).toBe(base);
  });
});

/* ── PLAN SAFETY ────────────────────────────────────────────────────────── */

const FORBIDDEN_PLAN_KEYS = ["to", "target", "data", "calldata", "callData", "abi", "selector", "signature", "signer",
  "privateKey", "key", "txHash", "hash", "rawTransaction", "serialized", "broadcast", "gas", "gasLimit", "nonce", "tx", "txs", "steps_tx", "approval", "spender"];
function allKeys(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.add(k); allKeys(x, acc); }
  return acc;
}

describe("plan safety", () => {
  it("13. the plan keeps the graph's (session) wallet, and refuses any other session", async () => {
    const { g, plan } = await planned(sendDraft());
    expect(plan.wallet).toBe(g.wallet);
    expect(plan.wallet.toLowerCase()).toBe(WALLET);
    const { planIntent } = await lib();
    expect(codeOf(() => planIntent(g, { sessionWallet: OTHER_WALLET }))).toBe("WALLET_MISMATCH");
    expect(codeOf(() => planIntent(g, { sessionWallet: null }))).toBe("WALLET_MISMATCH");
    expect(await resolveCode(sendDraft(), confirmedSwap("99000000"), { sessionWallet: OTHER_WALLET })).toBe("WALLET_MISMATCH");
  });

  it("14. chain 143 is kept, and is the only chain a plan can carry", async () => {
    const { plan } = await planned(sendDraft());
    expect(plan.chainId).toBe(143);
    expect(await validationCode(graph([swapNode()], "swap", { chainId: 1 }))).toBe("WRONG_CHAIN");
  });

  it("15. each step keeps the exact action identity and version, plus its policy, bindings and outputs", async () => {
    const { plan } = await planned(splitDraft());
    expect(plan.steps.map((s) => s.ref)).toEqual([
      { protocolId: "payai-swap", actionId: "swap", version: "1.0.0" },
      { protocolId: "payai-settlement", actionId: "split_payment", version: "2.0.0" },
    ]);
    expect(plan.steps[0]).toMatchObject({ dependsOn: [], outputsNeeded: ["amountOut"], expects: [], feePolicy: null });
    expect(plan.steps[1]).toMatchObject({
      dependsOn: ["n1"], outputsNeeded: [], feePolicy: { mode: "on_top" },
      expects: [{ path: "recipients[1].amount", node: "n1", output: "amountOut", type: "units", token: USDC }],
    });
    // Bindings stay unresolved in the plan; recipients stay as written.
    expect((plan.steps[1].inputs.recipients as { items: unknown[] }).items[1]).toEqual({
      recipient: payee("Bob"), amount: rem("n1", "amountOut", ["20000000"]),
    });
    expect(await validationCode(graph([node("n1", ["payai-swap", "swap", "1.0.1"], { tokenOut: lit(USDC), amountIn: lit("1") })], "swap"))).toBe("VERSION_MISMATCH");
  });

  it("16. no calldata, targets, signatures, keys or broadcast details anywhere in a plan", async () => {
    const { plan } = await planned(splitDraft());
    const keys = allKeys(plan);
    for (const k of FORBIDDEN_PLAN_KEYS) expect(keys.has(k), k).toBe(false);
    expect(Object.keys(plan).sort()).toEqual(["chainId", "graphHash", "planId", "steps", "wallet"]);
    for (const s of plan.steps) expect(Object.keys(s).sort()).toEqual(["dependsOn", "expects", "feePolicy", "inputs", "nodeId", "outputsNeeded", "ref"]);
    expect(JSON.stringify(plan)).not.toMatch(/0x[0-9a-f]{8}(?![0-9a-f])|0x[0-9a-f]{41,}/i); // no selector / calldata blobs
    expect(Object.isFrozen(plan) && Object.isFrozen(plan.steps) && Object.isFrozen(plan.steps[1].expects)).toBe(true);
  });

  it("17. planning and resolving execute nothing: no action quote/build/parseResult is ever called", async () => {
    const { getAction } = await import("@/lib/sdk/registry");
    const split = getAction("payai-settlement", "split_payment", "2.0.0")!;
    const quote = vi.spyOn(split, "quote");
    const build = vi.spyOn(split, "build");
    await resolve(splitDraft(), confirmedSwap("100000000"), { recipients: PINS, feeBps: 25 });
    await resolve(sendDraft(), confirmedSwap("99000000"));
    await resolve(splitDraft(PAYOUT), confirmedSwap("100000000"), { recipients: PINS, feeBps: 25 });
    expect(quote).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(spies.quote).not.toHaveBeenCalled();
    expect(spies.build).not.toHaveBeenCalled();
    expect(spies.parseResult).not.toHaveBeenCalled();
  });

  it("18. no signing, broadcasting, network, storage or LLM access in the planner modules", () => {
    for (const f of ["lib/plan/planner.ts", "lib/plan/resolve.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(["server-only", "node:crypto", "viem", "@/lib/sdk/fees", "@/lib/sdk/types", "./errors", "./validate", "./types", "./planner"], `${f} imports ${i}`).toContain(i);
      for (const bad of ["signTransaction", "signMessage", "signTypedData", ".sign(", "sendTransaction", "sendRawTransaction", "writeContract", "privateKey", "fetch(", "createWalletClient", "createPublicClient", "readContract", "redis", "kv.", "anthropic", "openai", "Date.now", "Math.random"]) {
        expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").includes(bad), `${f} contains ${bad}`).toBe(false);
      }
    }
  });
});

/* ── OUTPUT BINDINGS ────────────────────────────────────────────────────── */

describe("output bindings", () => {
  it("19. a verified, confirmed output binds — amount and token", async () => {
    const r = await resolve(sendDraft(), confirmedSwap("99500000"));
    expect(r).toEqual({ recipient: expect.any(String), token: USDC, amount: "99500000" });
    expect(r.recipient.toLowerCase()).toBe(RECIPIENT);
    expect(Object.isFrozen(r)).toBe(true);
    const tokenBound = graph([
      swapNode(),
      node("n2", T, { recipient: addr(RECIPIENT), token: out("n1", "tokenOut"), amount: out("n1", "amountOut") }, ["n1"]),
    ], SEND_TEXT);
    const r2 = await resolve(tokenBound, confirmedSwap("5"));
    expect(r2.token.toLowerCase()).toBe(USDC);
    expect(r2.amount).toBe("5");
  });

  it("20. a missing dependency is refused: undeclared at validation, unconfirmed at resolution", async () => {
    const d = sendDraft();
    (d.nodes[1] as { dependsOn: string[] }).dependsOn = [];
    expect(await validationCode(d)).toBe("UNDECLARED_DEPENDENCY");
    expect(await resolveCode(sendDraft(), {})).toBe("OUTPUT_NOT_CONFIRMED");
    expect(await resolveCode(sendDraft(), { n9: { amountOut: units("1") } })).toBe("OUTPUT_NOT_CONFIRMED");
  });

  it("21. an unknown output is refused: undeclared at validation, absent from the confirmation at resolution", async () => {
    const d = sendDraft();
    (d.nodes[1] as { inputs: Record<string, unknown> }).inputs.amount = out("n1", "price");
    expect(await validationCode(d)).toBe("UNKNOWN_OUTPUT");
    expect(await resolveCode(sendDraft(), { n1: {} })).toBe("UNKNOWN_OUTPUT");
    expect(await resolveCode(sendDraft(), { n1: { amountout: units("1") } })).toBe("UNKNOWN_OUTPUT");
    expect(await resolveCode(sendDraft(), { n1: Object.create({ amountOut: units("1") }) })).toBe("UNKNOWN_OUTPUT"); // inherited ≠ own
  });

  it("22. an unconfirmed producer is refused", async () => {
    expect(await resolveCode(sendDraft(), {})).toBe("OUTPUT_NOT_CONFIRMED");
    expect(await resolveCode(sendDraft(), Object.create({ n1: { amountOut: units("1") } }))).toBe("OUTPUT_NOT_CONFIRMED");
  });

  it("23. an unverified output is refused", async () => {
    expect(await resolveCode(sendDraft(), { n1: { amountOut: units("1", USDC, { verified: false }) } })).toBe("OUTPUT_NOT_VERIFIED");
    expect(await resolveCode(sendDraft(), { n1: { amountOut: units("1", USDC, { verified: "true" }) } })).toBe("OUTPUT_NOT_VERIFIED");
    expect(await resolveCode(sendDraft(), { n1: { amountOut: { type: "units", value: "1", token: USDC } } })).toBe("OUTPUT_NOT_VERIFIED");
    expect(await resolveCode(sendDraft(), { n1: { amountOut: null } })).toBe("OUTPUT_NOT_VERIFIED");
  });

  it("24. an invalid confirmed value is refused", async () => {
    for (const value of ["", "1.5", "-1", "0x10", "007", " 1", "1e6", (MAX_UINT256 + 1n).toString(), "0"]) {
      expect(await resolveCode(sendDraft(), { n1: { amountOut: units(value) } }), value).toBe("INVALID_CONFIRMED_VALUE");
    }
    expect(await resolveCode(sendDraft(), { n1: { amountOut: units(1 as never) } })).toBe("INVALID_CONFIRMED_VALUE");
    expect(await resolveCode(sendDraft(), { n1: { amountOut: { verified: true, type: "token", value: USDC, token: USDC } } })).toBe("INVALID_CONFIRMED_VALUE");
    expect(await resolveCode(sendDraft(), { n1: { amountOut: { verified: true, type: "units", value: "1" } } })).toBe("INVALID_CONFIRMED_VALUE"); // no token
    expect(await resolveCode(sendDraft(), { n1: { amountOut: units("1", "usdc") } })).toBe("INVALID_CONFIRMED_VALUE");
    const tokenBound = graph([swapNode(), node("n2", T, { recipient: addr(RECIPIENT), token: out("n1", "tokenOut"), amount: lit("1") }, ["n1"])], SEND_TEXT);
    expect(await resolveCode(tokenBound, confirmedSwap("1", { tokenOut: { verified: true, type: "token", value: "0x1234" } }))).toBe("INVALID_CONFIRMED_VALUE");
  });

  it("25. a token mismatch is refused", async () => {
    expect(await resolveCode(sendDraft(), { n1: { amountOut: units("1", WMON) } })).toBe("TOKEN_MISMATCH");
    const tokenBound = graph([swapNode(), node("n2", T, { recipient: addr(RECIPIENT), token: out("n1", "tokenOut"), amount: lit("1") }, ["n1"])], SEND_TEXT);
    expect(await resolveCode(tokenBound, confirmedSwap("1", { tokenOut: { verified: true, type: "token", value: WMON } }))).toBe("TOKEN_MISMATCH");
    expect(await resolveCode(tokenBound, confirmedSwap("1", { tokenOut: { verified: true, type: "token", value: USDC, token: WMON } }))).toBe("TOKEN_MISMATCH");
    // Statically, too: a USDC amount can't pay a WMON transfer.
    const d = sendDraft();
    (d.nodes[1] as { inputs: Record<string, unknown> }).inputs.token = lit(WMON);
    expect(await validationCode(d)).toBe("TOKEN_MISMATCH");
    // Checksummed vs lowercase is the same token, not a mismatch.
    expect((await resolve(sendDraft(), { n1: { amountOut: units("7", USDC.toUpperCase().replace("0X", "0x")) } })).amount).toBe("7");
  });

  it("26. a native MON output is refused — at validation and at resolution", async () => {
    expect(await resolveCode(sendDraft(), { n1: { amountOut: units("1", ZERO) } })).toBe("NATIVE_OUTPUT_NOT_BINDABLE");
    expect(await resolveCode(sendDraft(), { n1: { amountOut: units("1", "") } })).toBe("NATIVE_OUTPUT_NOT_BINDABLE");
    const tokenBound = graph([swapNode(), node("n2", T, { recipient: addr(RECIPIENT), token: out("n1", "tokenOut"), amount: lit("1") }, ["n1"])], SEND_TEXT);
    expect(await resolveCode(tokenBound, confirmedSwap("1", { tokenOut: { verified: true, type: "token", value: ZERO } }))).toBe("NATIVE_OUTPUT_NOT_BINDABLE");
    const nativeSwap = graph([
      node("n1", S, { tokenIn: lit(USDC), tokenOut: lit(ZERO), amountIn: lit("1") }),
      node("n2", T, { recipient: addr(RECIPIENT), amount: out("n1", "amountOut") }, ["n1"]),
    ], SEND_TEXT);
    expect(await validationCode(nativeSwap)).toBe("NATIVE_OUTPUT_NOT_BINDABLE");
  });

  it("27. a units[] output is never bindable", async () => {
    const d = graph([
      node("n1", SPLIT, { token: lit(USDC), recipients: { kind: "list", items: [
        { recipient: addr(ALICE_ADDR), amount: lit("1") }, { recipient: addr(BOB_ADDR), amount: lit("1") }] } }),
      node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "recipientAmounts") }, ["n1"]),
    ], `split to ${ALICE_ADDR} and ${BOB_ADDR} then send to ${RECIPIENT}`);
    expect(await validationCode(d)).toBe("OUTPUT_TYPE_MISMATCH");
    expect(await resolveCode(sendDraft(), { n1: { amountOut: { verified: true, type: "units[]", value: "1", token: USDC } } })).toBe("INVALID_CONFIRMED_VALUE");
  });
});

/* ── REMAINDERS ─────────────────────────────────────────────────────────── */

describe("remainders", () => {
  it("28. a simple remainder (no fee policy) is confirmed minus fixed", async () => {
    expect((await resolve(restDraft(), confirmedSwap("100000000"))).amount).toBe("80000000");
    const r = await resolve(splitDraft(LOOKALIKE), confirmedSwap("100000000"), { recipients: PINS });
    expect(items(r)).toEqual([{ recipient: ALICE_ADDR, amount: "20000000" }, { recipient: BOB_ADDR, amount: "80000000" }]);
  });

  it("29. underflow is refused", async () => {
    expect(await resolveCode(restDraft(), confirmedSwap("19999999"))).toBe("REMAINDER_UNDERFLOW");
    expect(await resolveCode(splitDraft(LOOKALIKE), confirmedSwap("1"), { recipients: PINS })).toBe("REMAINDER_UNDERFLOW");
  });

  it("30. overflow beyond uint256 is refused", async () => {
    const huge = "9".repeat(78);
    expect(await resolveCode(restDraft([huge]), confirmedSwap(MAX_UINT256.toString()))).toBe("REMAINDER_OVERFLOW");
    expect(await resolveCode(restDraft([(MAX_UINT256 / 2n + 1n).toString(), (MAX_UINT256 / 2n + 1n).toString()]), confirmedSwap(MAX_UINT256.toString()))).toBe("REMAINDER_OVERFLOW");
  });

  it("31. a zero remainder is refused", async () => {
    expect(await resolveCode(restDraft(), confirmedSwap("20000000"))).toBe("REMAINDER_UNDERFLOW");
    expect(await resolveCode(splitDraft(LOOKALIKE), confirmedSwap("20000000"), { recipients: PINS })).toBe("REMAINDER_UNDERFLOW");
    expect((await resolve(restDraft(), confirmedSwap("20000001"))).amount).toBe("1");
  });

  it("32. more than one remainder in a list is refused; a remainder whose terms don't match the list is refused", async () => {
    const d = splitDraft();
    ((d.nodes[1] as { inputs: { recipients: { items: { amount: unknown }[] } } }).inputs.recipients.items[0]).amount = rem("n1", "amountOut", ["1"]);
    expect(await validationCode(d)).toBe("INVALID_BINDING");
    expect(await resolveCode(splitDraft(LOOKALIKE, "20000000", ["10000000"]), confirmedSwap("100000000"), { recipients: PINS })).toBe("INVALID_REMAINDER");
    expect(await resolveCode(splitDraft(SPLIT, "20000000", ["30000000"]), confirmedSwap("100000000"), { recipients: PINS, feeBps: 25 })).toBe("INVALID_REMAINDER");
  });

  it("33. remainder arithmetic is exact BigInt — no Number rounding", async () => {
    const available = (1n << 200n) + 123456789n;
    const fixed = 9007199254740993n; // 2^53 + 1: not representable as a Number
    const r = await resolve(restDraft([fixed.toString()]), confirmedSwap(available.toString()));
    expect(r.amount).toBe((available - fixed).toString());
    expect(BigInt(r.amount) + fixed).toBe(available);
  });

  it("34. the uint256 boundary: MAX_UINT256 is accepted, MAX_UINT256 + 1 is not", async () => {
    expect((await resolve(restDraft(["1"]), confirmedSwap(MAX_UINT256.toString()))).amount).toBe((MAX_UINT256 - 1n).toString());
    expect((await resolve(sendDraft(), confirmedSwap(MAX_UINT256.toString()))).amount).toBe(MAX_UINT256.toString());
    expect(await resolveCode(restDraft(["1"]), confirmedSwap((MAX_UINT256 + 1n).toString()))).toBe("INVALID_CONFIRMED_VALUE");
  });
});

/* ── FEE-ON-TOP ─────────────────────────────────────────────────────────── */

const feeOf = (t: bigint, bps: number) => (t * BigInt(bps)) / 10000n;

describe("fee-on-top remainders", () => {
  it("35. the fee-inclusive remainder: 100 USDC out, Alice 20 USDC, 25 bps → Bob 79.750624 USDC", async () => {
    const r = await resolve(splitDraft(), confirmedSwap("100000000"), { recipients: PINS, feeBps: 25 });
    expect(items(r)).toEqual([{ recipient: ALICE_ADDR, amount: "20000000" }, { recipient: BOB_ADDR, amount: "79750624" }]);
    const total = 20000000n + 79750624n;
    expect(total + feeOf(total, 25)).toBeLessThanOrEqual(100000000n);
    expect(total + 1n + feeOf(total + 1n, 25)).toBeGreaterThan(100000000n); // largest
  });

  it("36. the fee rate is whatever is supplied — never a built-in 25 bps", async () => {
    const bob = async (bps: number) => items(await resolve(splitDraft(), confirmedSwap("100000000"), { recipients: PINS, feeBps: bps }))[1].amount;
    expect(await bob(0)).toBe("80000000");
    expect(await bob(10)).toBe("79900100"); // 99,900,100 + floor(99,900,100 * 10 / 10000) = 100,000,000
    expect(await bob(100)).toBe("79009901");
    expect(new Set([await bob(0), await bob(10), await bob(25), await bob(100)]).size).toBe(4);
    const src = readFileSync(join(process.cwd(), "lib/plan/resolve.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/\b25n?\b/);
  });

  it("37. a fee-on-top remainder without an authoritative fee rate is refused", async () => {
    for (const feeBps of [undefined, null, "25", 2.5, -1, 101, Number.NaN, Infinity]) {
      expect(await resolveCode(splitDraft(), confirmedSwap("100000000"), { recipients: PINS, feeBps }), String(feeBps)).toBe("FEE_TERMS_UNAVAILABLE");
    }
    // A step with no remainder needs no fee rate (nothing to compute).
    const fixedOnly = graph([swapNode(), node("n2", SPLIT, { token: lit(USDC), recipients: { kind: "list", items: [
      { recipient: payee("Alice"), amount: lit("1") }, { recipient: payee("Bob"), amount: out("n1", "amountOut") }] } }, ["n1"])], SPLIT_TEXT);
    expect(items(await resolve(fixedOnly, confirmedSwap("5"), { recipients: PINS }))[1].amount).toBe("5");
  });

  it("38. integer arithmetic: matches a brute-force search, including far beyond 2^53", async () => {
    const { feeInclusiveRemainder } = await lib();
    const brute = (a: bigint, f: bigint, b: number) => {
      let best: bigint | null = null;
      for (let t = 0n; t <= a; t++) if (t + feeOf(t, b) <= a && t - f > 0n) best = t - f;
      return best;
    };
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 300; i++) {
      const a = BigInt(rnd(3000)); const f = BigInt(rnd(1500)); const b = rnd(101);
      expect(feeInclusiveRemainder(a, f, b), `${a} ${f} ${b}`).toBe(brute(a, f, b));
    }
    const big = (1n << 255n) + 987654321987654321n;
    const r = feeInclusiveRemainder(big, 12345n, 25)!;
    const t = r + 12345n;
    expect(t + feeOf(t, 25)).toBeLessThanOrEqual(big);
    expect(t + 1n + feeOf(t + 1n, 25)).toBeGreaterThan(big);
  });

  it("39. the remainder accounts for the fee: recipients + fee never exceed what was confirmed", async () => {
    for (const available of ["100000000", "123456789", "20050001", "99999999999"]) {
      const r = items(await resolve(splitDraft(), confirmedSwap(available), { recipients: PINS, feeBps: 25 }));
      const total = BigInt(r[0].amount) + BigInt(r[1].amount);
      expect(total + feeOf(total, 25)).toBeLessThanOrEqual(BigInt(available));
      expect(BigInt(r[1].amount)).toBeLessThan(BigInt(available) - 20000000n);
    }
  });

  it("40. not enough for the fixed amounts plus the fee is refused", async () => {
    // 20 USDC + 0.05 USDC fee = 20.05 USDC: nothing is left for Bob…
    expect(await resolveCode(splitDraft(), confirmedSwap("20050000"), { recipients: PINS, feeBps: 25 })).toBe("REMAINDER_UNDERFLOW");
    expect(await resolveCode(splitDraft(), confirmedSwap("20000000"), { recipients: PINS, feeBps: 25 })).toBe("REMAINDER_UNDERFLOW");
    expect(await resolveCode(splitDraft(), confirmedSwap("1"), { recipients: PINS, feeBps: 25 })).toBe("REMAINDER_UNDERFLOW");
    // …one more base unit and Bob gets exactly 1.
    expect(items(await resolve(splitDraft(), confirmedSwap("20050001"), { recipients: PINS, feeBps: 25 }))[1].amount).toBe("1");
  });
});

/* ── RECIPIENTS ─────────────────────────────────────────────────────────── */

describe("recipients", () => {
  it("41. a typed 0x address is preserved (checksummed), with no resolution needed", async () => {
    const { getAddress } = await import("viem");
    const r = await resolve(sendDraft(), confirmedSwap("1"));
    expect(r.recipient).toBe(getAddress(RECIPIENT));
  });

  it("42. an unresolved .nad or payee recipient fails closed", async () => {
    expect(await resolveCode(splitDraft(), confirmedSwap("100000000"), { feeBps: 25 })).toBe("RECIPIENT_UNRESOLVED");
    expect(await resolveCode(splitDraft(), confirmedSwap("100000000"), { feeBps: 25, recipients: { "payee:alice": ALICE_ADDR } })).toBe("RECIPIENT_UNRESOLVED");
    for (const bad of [ZERO, "0x1234", "alice.nad", ""]) {
      expect(await resolveCode(splitDraft(), confirmedSwap("100000000"), { feeBps: 25, recipients: { ...PINS, "payee:bob": bad } }), bad).toBe("RECIPIENT_UNRESOLVED");
    }
    expect(await resolveCode(splitDraft(), confirmedSwap("100000000"), { feeBps: 25, recipients: Object.create(PINS) })).toBe("RECIPIENT_UNRESOLVED");
    const nadDraft = graph([node("n1", T, { recipient: nad("alice.nad"), token: lit(USDC), amount: lit("1") })], "send 1 USDC to alice.nad");
    expect(await resolveCode(nadDraft, {}, { nodeId: "n1" })).toBe("RECIPIENT_UNRESOLVED");
    expect((await resolve(nadDraft, {}, { nodeId: "n1", recipients: { "nad:alice.nad": ALICE_ADDR } })).recipient).toBe(ALICE_ADDR);
    // Keys are source-specific: a payee pin never resolves a .nad name.
    expect(await resolveCode(nadDraft, {}, { nodeId: "n1", recipients: { "payee:alice.nad": ALICE_ADDR } })).toBe("RECIPIENT_UNRESOLVED");
  });

  it("43. a server-resolved recipient is used as pinned", async () => {
    const { recipientKey } = await lib();
    expect(recipientKey({ source: "payee", display: " Alice " })).toBe("payee:alice");
    const r = items(await resolve(splitDraft(), confirmedSwap("100000000"), { recipients: PINS, feeBps: 25 }));
    expect(r.map((i) => i.recipient)).toEqual([ALICE_ADDR, BOB_ADDR]);
  });

  it("44. a recipient can't be overridden — not by a pin for a typed address, not by a confirmed output", async () => {
    const { getAddress } = await import("viem");
    const r = await resolve(sendDraft(), {
      n1: { ...confirmedSwap("1").n1, recipient: { verified: true, type: "token", value: OTHER_WALLET } },
    }, { recipients: { [`address:${RECIPIENT}`]: OTHER_WALLET, "address:recipient": OTHER_WALLET } });
    expect(r.recipient).toBe(getAddress(RECIPIENT));
    // A recipient input can't be bound to an output at all.
    const d = sendDraft();
    (d.nodes[1] as { inputs: Record<string, unknown> }).inputs.recipient = out("n1", "tokenOut");
    expect(await validationCode(d)).toBe("OUTPUT_TYPE_MISMATCH");
    // And the resolved inputs can't be edited afterwards.
    const s = await resolve(splitDraft(), confirmedSwap("100000000"), { recipients: PINS, feeBps: 25 });
    expect(() => { items(s)[1].recipient = OTHER_WALLET; }).toThrow(TypeError);
  });
});

/* ── ACTION METADATA ────────────────────────────────────────────────────── */

describe("action metadata", () => {
  it("45. the fee policy comes from Action.feePolicy metadata", async () => {
    const { getAction } = await import("@/lib/sdk/registry");
    expect(getAction("payai-settlement", "split_payment", "2.0.0")!.feePolicy).toEqual({ mode: "on_top" });
    const { g, plan } = await planned(splitDraft());
    expect(g.feePolicies).toEqual({ n2: { mode: "on_top" } });
    expect(plan.steps.map((s) => s.feePolicy)).toEqual([null, { mode: "on_top" }]);
    // An unrelated action declaring on_top gets exactly the same treatment.
    const p = items(await resolve(splitDraft(PAYOUT), confirmedSwap("100000000"), { recipients: PINS, feeBps: 25 }));
    expect(p[1].amount).toBe("79750624");
    expect(await resolveCode(splitDraft(PAYOUT), confirmedSwap("100000000"), { recipients: PINS })).toBe("FEE_TERMS_UNAVAILABLE");
    // The fee policy isn't part of the graph's identity.
    const { graphHash } = await lib();
    expect(graphHash({ ...JSON.parse(JSON.stringify(g)), feePolicies: {} })).toBe(graphHash(g));
  });

  it("46. nothing keys off the SplitSettlement identity: a same-named action without the policy gets no fee", async () => {
    const r = items(await resolve(splitDraft(LOOKALIKE), confirmedSwap("100000000"), { recipients: PINS }));
    expect(r[1].amount).toBe("80000000");
    const { plan } = await planned(splitDraft(LOOKALIKE));
    expect(plan.steps[1].feePolicy).toBeNull();
    for (const f of ["lib/plan/planner.ts", "lib/plan/resolve.ts", "lib/plan/validate.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/split_payment|payai-settlement|SplitSettlement|actionId\s*===|protocolId\s*===/);
    }
  });
});

/* ── Regressions / edge cases found while implementing ──────────────────── */

describe("edge cases", () => {
  it("a forged plan, an unknown step, or a plan paired with another graph is refused", async () => {
    const { plan, g } = await planned(sendDraft());
    const { resolveStepInputs } = await lib();
    const base = { graph: g, sessionWallet: WALLET, confirmed: confirmedSwap("1") as never };
    expect(codeOf(() => resolveStepInputs({ ...base, plan: JSON.parse(JSON.stringify(plan)), nodeId: "n2" }))).toBe("INVALID_PLAN");
    expect(codeOf(() => resolveStepInputs({ ...base, plan, nodeId: "n9" }))).toBe("INVALID_PLAN");
    expect(codeOf(() => resolveStepInputs({ ...base, plan, nodeId: "__proto__" }))).toBe("INVALID_PLAN");
    const other = await validated(restDraft());
    expect(codeOf(() => resolveStepInputs({ ...base, graph: other, plan, nodeId: "n2" }))).toBe("GRAPH_MUTATION");
    expect(codeOf(() => resolveStepInputs({ ...base, plan, nodeId: "n2" }))).toBe("NO_ERROR");
  });

  it("the first step resolves with nothing confirmed; prototype keys never resolve", async () => {
    expect(await resolve(sendDraft(), {}, { nodeId: "n1" })).toEqual({ tokenOut: USDC, amountIn: "100000000000000000000" });
    expect(await resolveCode(sendDraft(), JSON.parse('{"__proto__":{"n1":{}}}'))).toBe("OUTPUT_NOT_CONFIRMED");
  });

  it("a fee-on-top scalar remainder (no list to define the fee base) is refused", async () => {
    const d = graph([swapNode(), node("n2", TIP, { recipient: addr(RECIPIENT), token: lit(USDC), amount: rem("n1", "amountOut", ["1"]) }, ["n1"])], SEND_TEXT);
    expect(await resolveCode(d, confirmedSwap("100000000"), { feeBps: 25 })).toBe("INVALID_REMAINDER");
  });

  it("validation refuses an action declaring a fee policy PayAI doesn't support", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    registerProtocol(fixture("weird", { actionId: "pay", version: "1.0.0", name: "x", description: "x", inputSchema: listSchema, feePolicy: { mode: "included" } as never }));
    const d = graph([node("n1", ["weird", "pay", "1.0.0"], { token: lit(USDC), recipients: { kind: "list", items: [
      { recipient: addr(ALICE_ADDR), amount: lit("1") }, { recipient: addr(BOB_ADDR), amount: lit("1") }] } })], `pay ${ALICE_ADDR} ${BOB_ADDR}`);
    expect(await validationCode(d)).toBe("MALFORMED");
  });

  it("boundOutputs records exactly what was proven, and outputsNeeded is sorted", async () => {
    const d = graph([swapNode(), node("n2", T, { recipient: addr(RECIPIENT), token: out("n1", "tokenOut"), amount: out("n1", "amountOut") }, ["n1"])], SEND_TEXT);
    const { g, plan } = await planned(d);
    expect(g.boundOutputs).toEqual({ n1: { amountOut: { type: "units", token: USDC }, tokenOut: { type: "token", token: USDC } } });
    expect(plan.steps[0].outputsNeeded).toEqual(["amountOut", "tokenOut"]);
    expect(plan.steps[1].expects.map((e) => e.path)).toEqual(["amount", "token"]); // inputs in canonical (sorted) key order
  });

  it("canonicalize refuses non-JSON values instead of dropping them", async () => {
    const { canonicalize } = await lib();
    expect(codeOf(() => canonicalize({ a: () => 1 }))).toBe("INVALID_PLAN");
    expect(codeOf(() => canonicalize([undefined]))).toBe("INVALID_PLAN");
    expect(codeOf(() => canonicalize({ a: Number.NaN }))).toBe("INVALID_PLAN");
    expect(codeOf(() => canonicalize({ a: new Date(0) }))).toBe("INVALID_PLAN");
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });
});
