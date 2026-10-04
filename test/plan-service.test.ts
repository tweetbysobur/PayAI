import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, ActionInputs, ProtocolAdapter } from "@/lib/sdk/types";

/**
 * Phase 2C Stage 3B — the Plan Service (lib/plan/service.ts).
 *
 * Real: registry (mainnet built-ins + TEST-ONLY fixtures), validator,
 * planner, resolver, Plan Store (in-memory), canonical quote helper
 * (lib/sdk/preview.ts) and quote tokens, and the SDK's own build / settle /
 * output records (written here exactly as the build and confirm routes write
 * them). Mocked: the recipient resolver (.nad/payee lookups), the live fee
 * read and the payment policy — each under test control.
 */

const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const OTHER_WALLET = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const RECIPIENT = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const ZERO = "0x0000000000000000000000000000000000000000";
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/* ── Mocks under test control ──────────────────────────────────────────── */

const ctl = vi.hoisted(() => ({
  /** display (lowercase) → resolution */
  resolutions: new Map<string, unknown>(),
  resolverCalls: [] as string[],
  feeBps: 25 as number | null,
  policy: null as null | { allowed: boolean; reason?: string },
  quoteFeeBps: null as number | null,   // what the on-top fixture quotes with (null = ctl.feeBps)
  quoteThrows: null as null | "input" | "internal",
  quoteCalls: [] as { actionId: string; inputs: unknown }[],
  buildCalls: 0,
}));

vi.mock("@/lib/payees/resolve", () => ({
  resolveRecipientInput: async (input: string) => {
    ctl.resolverCalls.push(input);
    const r = ctl.resolutions.get(input.trim().toLowerCase());
    return r ?? { ok: false, message: `"${input}" isn't a valid address, .nad domain, or known payee.` };
  },
}));
vi.mock("@/lib/sdk/fees", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sdk/fees")>();
  return {
    ...actual,
    readPlatformFeeTerms: async () => {
      if (ctl.feeBps === null) throw new actual.PlatformFeeUnavailableError("PayAI's fee configuration is unavailable.");
      return { feeBps: ctl.feeBps, treasury: "0xA282833B52b1B66D58bD2007081dCC037798C0b0", source: "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D" };
    },
  };
});
vi.mock("@/lib/sdk/policy", () => ({
  enforcePaymentPolicy: async () => ctl.policy
    ? { allowed: ctl.policy.allowed, reason: ctl.policy.reason, warnings: [], riskScore: 90, riskLevel: "high", compliance: "rejected" }
    : { allowed: true, warnings: ["fine"], riskScore: 5, riskLevel: "low", compliance: "approved" },
}));

/* ── Registry fixtures (quote is real-shaped; build must never be called) ─ */

function fixture(protocolId: string, action: Omit<Action, "protocolId" | "chainId" | "allowedTargets" | "quote" | "build" | "parseResult">): ProtocolAdapter {
  const target = "0x00000000000000000000000000000000000000f1" as const;
  return {
    protocolId, name: `${protocolId} (test fixture)`, chainId: 143, allowedTargets: [target],
    actions: [{
      ...action, protocolId, chainId: 143, allowedTargets: [target],
      async quote(inputs: ActionInputs) {
        ctl.quoteCalls.push({ actionId: action.actionId, inputs });
        if (ctl.quoteThrows === "input") {
          const { ActionInputError } = await import("@/lib/sdk/types");
          throw new ActionInputError("That amount is too small to quote.");
        }
        if (ctl.quoteThrows === "internal") throw new Error("engine down");
        const terms = action.feePolicy ? { feeBps: String(ctl.quoteFeeBps ?? ctl.feeBps) } : { kind: action.actionId };
        return { summary: `${action.actionId} quote`, details: { what: action.actionId }, quotedAt: Date.now(), terms };
      },
      async build() { ctl.buildCalls++; throw new Error("build must not be called by the Plan Service"); },
      async parseResult() { throw new Error("parseResult must not be called"); },
      async outflows() { return []; },
    } as unknown as Action],
  };
}
const TRANSFER = fixture("payai", {
  actionId: "transfer", version: "1.0.0", name: "Transfer", description: "fixture (no confirmed outputs)",
  inputSchema: {
    recipient: { type: "address", required: true, description: "to" },
    token: { type: "token", required: false, description: "token" },
    amount: { type: "units", required: true, description: "amount" },
  },
});
const SWAP = fixture("payai-swap", {
  actionId: "swap", version: "1.0.0", name: "Swap", description: "fixture",
  inputSchema: {
    tokenIn: { type: "token", required: false, description: "in" },
    tokenOut: { type: "token", required: true, description: "out" },
    amountIn: { type: "units", required: true, description: "amount in" },
  },
  outputs: {
    amountOut: { type: "units", description: "out", denominatedIn: { input: "tokenOut" } },
    tokenOut: { type: "token", description: "token", denominatedIn: { input: "tokenOut" } },
  },
});
const PAYOUT = fixture("acme", {
  actionId: "payout", version: "3.1.0", name: "Payout", description: "fixture, fee on top", feePolicy: { mode: "on_top" },
  inputSchema: {
    recipients: {
      type: "list", required: true, minItems: 2, maxItems: 9, description: "who",
      items: { recipient: { type: "address", required: true, description: "to" }, amount: { type: "units", required: true, description: "amount" } },
    },
    token: { type: "token", required: false, description: "token" },
  },
});

let savedNetwork: string | undefined;
let savedUsdc: string | undefined;
beforeEach(async () => {
  savedNetwork = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  // The configured stablecoin, so a payai/transfer plan in it is reviewable (Stage 5B).
  savedUsdc = process.env.MONAD_MAINNET_USDC;
  process.env.MONAD_MAINNET_USDC = USDC;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  Object.assign(ctl, { feeBps: 25, policy: null, quoteFeeBps: null, quoteThrows: null, buildCalls: 0 });
  ctl.quoteCalls.length = 0;
  ctl.resolverCalls.length = 0;
  ctl.resolutions.clear();
  ctl.resolutions.set("alice", { ok: true, address: ALICE, source: "payee", display: "Alice", domain: null, asResolved: ALICE });
  ctl.resolutions.set("bob.nad", { ok: true, address: BOB, source: "nad", display: "bob.nad", domain: "bob.nad", asResolved: BOB });
  (globalThis as unknown as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  (await import("@/lib/plan/store")).__resetPlanStoreForTests();
  (await import("@/lib/sdk/settlement")).__resetOutputRecordsForTests();
  const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
  for (const p of [TRANSFER, SWAP, PAYOUT]) registerProtocol(p);
});
afterEach(() => {
  if (savedNetwork === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = savedNetwork;
  if (savedUsdc === undefined) delete process.env.MONAD_MAINNET_USDC; else process.env.MONAD_MAINNET_USDC = savedUsdc;
  vi.useRealTimers();
});

/* ── Builders ──────────────────────────────────────────────────────────── */

type Ref = [string, string, string];
const T: Ref = ["payai", "transfer", "1.0.0"];
const S: Ref = ["payai-swap", "swap", "1.0.0"];
const P: Ref = ["acme", "payout", "3.1.0"];
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
function graph(nodes: unknown[], text: string, id = "intent_svc_00001", wallet = WALLET) {
  return { id, version: 1, chainId: 143, wallet, nodes, status: "draft", source: { text, adapter: "deterministic", adapterVersion: "1" } };
}
const swapNode = () => node("n1", S, { tokenOut: lit(USDC), amountIn: lit("100000000000000000000") });
const sendDraft = (id?: string) => graph([
  swapNode(),
  node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "amountOut") }, ["n1"]),
], `swap 100 MON to USDC and send the USDC to ${RECIPIENT}`, id);
/** swap → payout(Alice 20 USDC, bob.nad the rest), fee on top. */
const payoutDraft = (id?: string) => graph([
  swapNode(),
  node("n2", P, { token: lit(USDC), recipients: { kind: "list", items: [
    { recipient: payee("Alice"), amount: lit("20000000") },
    { recipient: nad("bob.nad"), amount: rem("n1", "amountOut", ["20000000"]) },
  ] } }, ["n1"]),
], "swap 100 MON to USDC, send 20 USDC to Alice and the rest to bob.nad", id);
/** A single transfer — an action WITHOUT confirmedOutputs. */
const singleDraft = (id?: string) => graph([node("n1", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: lit("1000000") })], `send 1 USDC to ${RECIPIENT}`, id);

const AUTH = { wallet: WALLET };
const OTHER = { wallet: OTHER_WALLET };
async function svc() { return import("@/lib/plan/service"); }
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as { code?: string }).code ?? `THREW:${(e as Error).message}`; }
  return "OK";
}
let seq = 0;
const txHash = () => `0x${(++seq).toString(16).padStart(64, "e")}`;

/* SDK records, exactly as the build / confirm routes write them. */
async function seedBuild(quoteId: string, ref: Ref, wallet = WALLET) {
  const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
  const { buildKey } = await import("@/lib/sdk/settlement");
  await claimRequest(buildKey(quoteId));
  await completeRequest(buildKey(quoteId), {
    protocolId: ref[0], actionId: ref[1], version: ref[2], wallet: wallet.toLowerCase(),
    finalTx: { to: "0x00000000000000000000000000000000000000f1", data: "0x", value: "0" }, riskScore: null, compliance: null, builtAt: Date.now(),
  });
}
async function seedVerdict(tx: string, body: Record<string, unknown>) {
  const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
  const { settleKey } = await import("@/lib/sdk/settlement");
  await claimRequest(settleKey(tx));
  await completeRequest(settleKey(tx), body);
}
const OK_VERDICT = { ok: true, success: true, explorerUrl: "x", details: {}, recorded: 1 };
const units = (value: string, token = USDC) => ({ verified: true as const, type: "units" as const, value, token });
const SWAP_OUTPUTS = (amountOut = "100000000") => ({ amountOut: units(amountOut), tokenOut: { verified: true as const, type: "token" as const, value: USDC } });
async function seedOutputs(quoteId: string, tx: string, ref: Ref, outputs: Record<string, unknown>, wallet = WALLET) {
  const { insertOutputRecordOnce } = await import("@/lib/sdk/settlement");
  return insertOutputRecordOnce({ quoteId, txHash: tx.toLowerCase(), wallet: wallet.toLowerCase(), protocolId: ref[0], actionId: ref[1], version: ref[2], outputs: outputs as never, recordedAt: Date.now() });
}

async function created(draft: unknown = sendDraft()) {
  const s = await svc();
  return s.createPlan(AUTH, draft);
}
/** Approval as SETUP for post-approval behaviour: straight through the store,
 *  which skips only the service's Stage 5B review guard (these drafts use
 *  test-only actions that are deliberately not reviewable). Approval itself
 *  is tested through the service in "approvePlan" below. */
async function storeApprove(planId: string) {
  const store = await import("@/lib/plan/store");
  await store.approvePlan(planId, { sessionWallet: WALLET, activeChainId: 143 });
}
async function approved(draft: unknown = sendDraft()) {
  const s = await svc();
  const v = await s.createPlan(AUTH, draft);
  await storeApprove(v.planId);
  return v.planId;
}
/** quote → bind → (build) → tx → (confirm) → settle, for one step. */
async function runStep(planId: string, nodeId: string, ref: Ref, o: { outputs?: Record<string, unknown> | null; verdict?: Record<string, unknown> } = {}) {
  const s = await svc();
  const q = await s.quoteStep(AUTH, planId, nodeId);
  await s.bindQuote(AUTH, planId, nodeId, q.quoteToken);
  await seedBuild(q.quoteId, ref);
  const tx = txHash();
  await s.recordTx(AUTH, planId, nodeId, { quoteId: q.quoteId, txHash: tx });
  await seedVerdict(tx, o.verdict ?? OK_VERDICT);
  if (o.outputs !== null) await seedOutputs(q.quoteId, tx, ref, o.outputs ?? SWAP_OUTPUTS());
  const view = await s.settleStep(AUTH, planId, nodeId);
  return { q, tx, view };
}
async function rawStoreDump(): Promise<string> {
  const g = globalThis as unknown as { __payaiPlanStore: { kv: Map<string, { json: string }> } };
  return [...g.__payaiPlanStore.kv.values()].map((e) => e.json).join("\n");
}

/* ══ Create ═════════════════════════════════════════════════════════════ */

describe("createPlan", () => {
  it("validates, plans and stores the draft for the authenticated wallet; returns a safe view", async () => {
    const v = await created();
    const { planIntent } = await import("@/lib/plan/planner");
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const g = validateIntentGraph(sendDraft(), { sessionWallet: WALLET, activeChainId: 143 });
    expect(v.planId).toBe(g.ok && planIntent(g.value, { sessionWallet: WALLET }).planId); // deterministic, server-derived
    expect(v).toMatchObject({ state: "planned", approved: false, abandoned: false, expired: false, approvable: true, currentStep: "n1", recipients: {} });
    expect(v.nodes.map((n) => [n.nodeId, n.state])).toEqual([["n1", "pending"], ["n2", "pending"]]);
    expect(Object.keys(v).sort()).toEqual(["abandoned", "approvable", "approveBy", "approved", "createdAt", "currentStep", "expired", "expiresAt", "nodes", "planId", "recipients", "state"]);
  });

  it("resolves .nad and payee recipients server-side and pins them", async () => {
    const v = await created(payoutDraft());
    expect(ctl.resolverCalls.sort()).toEqual(["Alice", "bob.nad"]);
    expect(v.recipients).toEqual({ "payee:alice": ALICE, "nad:bob.nad": BOB });
  });

  it("refuses an unresolved recipient, a source mismatch, or a zero address — nothing is stored", async () => {
    const s = await svc();
    for (const setup of [
      () => ctl.resolutions.delete("bob.nad"),
      () => ctl.resolutions.set("bob.nad", { ok: true, address: BOB, source: "payee", display: "bob.nad", domain: null, asResolved: BOB }),
      () => ctl.resolutions.set("bob.nad", { ok: true, address: ZERO, source: "nad", display: "bob.nad", domain: "bob.nad", asResolved: ZERO }),
    ]) {
      ctl.resolutions.set("bob.nad", { ok: true, address: BOB, source: "nad", display: "bob.nad", domain: "bob.nad", asResolved: BOB });
      setup();
      expect(await code(s.createPlan(AUTH, payoutDraft()))).toBe("RECIPIENT_UNRESOLVED");
    }
    expect(await s.listPlans(AUTH)).toEqual([]);
  });

  it("an invalid draft is refused (INVALID_PLAN with the validator's path); the draft's wallet must be the authenticated one", async () => {
    const s = await svc();
    expect(await code(s.createPlan(AUTH, { nope: true }))).toBe("INVALID_PLAN");
    expect(await code(s.createPlan(AUTH, graph([node("n1", T, { recipient: addr(RECIPIENT), amount: lit("1"), to: lit("x") })], `send to ${RECIPIENT}`)))).toBe("INVALID_PLAN");
    expect(await code(s.createPlan(OTHER, sendDraft()))).toBe("INVALID_PLAN"); // draft wallet ≠ authenticated wallet
    expect(await code(s.createPlan({ wallet: "" }, sendDraft()))).toBe("INVALID_PLAN");
    const err = await s.createPlan(AUTH, sendDraft("x")).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INVALID_PLAN", path: "$.id" });
  });

  it("client-supplied structure, state, outputs or pins are never accepted", async () => {
    const s = await svc();
    for (const extra of [{ planId: "plan_x" }, { graphHash: "0".repeat(64) }, { order: ["n2", "n1"] }, { pins: { "payee:alice": BOB } }, { state: "completed" }]) {
      expect(await code(s.createPlan(AUTH, { ...sendDraft(), ...extra }))).toBe("INVALID_PLAN");
    }
    const d = sendDraft();
    (d.nodes[0] as { execution: unknown }).execution = { state: "confirmed" };
    expect(await code(s.createPlan(AUTH, d))).toBe("INVALID_PLAN");
  });

  it("duplicate create is idempotent; a conflicting re-pin is CONFLICT", async () => {
    const a = await created(payoutDraft());
    vi.setSystemTime(T0 + MIN);
    const b = await created(payoutDraft());
    expect(b.planId).toBe(a.planId);
    expect(b.createdAt).toBe(a.createdAt);
    ctl.resolutions.set("alice", { ok: true, address: BOB, source: "payee", display: "Alice", domain: null, asResolved: BOB });
    expect(await code(created(payoutDraft()))).toBe("CONFLICT");
  });

  it("an action without confirmedOutputs is accepted at create", async () => {
    expect(await code(created(singleDraft()))).toBe("OK");
  });
});

/* ══ Authorization ══════════════════════════════════════════════════════ */

describe("authorization", () => {
  it("every operation is bound to auth.wallet; another wallet sees NOT_FOUND (existence isn't disclosed)", async () => {
    const planId = await approved();
    const s = await svc();
    for (const op of [
      s.getPlan(OTHER, planId), s.approvePlan(OTHER, planId), s.nextStep(OTHER, planId), s.quoteStep(OTHER, planId, "n1"),
      s.bindQuote(OTHER, planId, "n1", "t"), s.recordTx(OTHER, planId, "n1", { quoteId: "0".repeat(32), txHash: txHash() }),
      s.settleStep(OTHER, planId, "n1"), s.abandonPlan(OTHER, planId),
    ]) expect(await code(op)).toBe("NOT_FOUND");
    expect(await code(s.getPlan(OTHER, `plan_${"9".repeat(32)}`))).toBe("NOT_FOUND");
    expect(await code(s.getPlan(AUTH, planId))).toBe("OK");
    expect(await s.listPlans(OTHER)).toEqual([]);
  });

  it("missing authentication fails closed", async () => {
    const planId = await approved();
    const s = await svc();
    expect(await code(s.getPlan({ wallet: undefined as never }, planId))).toBe("NOT_FOUND");
    expect(await code(s.getPlan(null as never, planId))).toBe("NOT_FOUND");
    expect(await s.listPlans(null as never)).toEqual([]);
  });

  it("the service never reads HTTP, cookies or request bodies", () => {
    const src = readFileSync(join(process.cwd(), "lib/plan/service.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const bad of ["next/server", "NextRequest", "cookies", "headers", "req.", "walletGrant", "request.json"]) expect(src.includes(bad), bad).toBe(false);
  });
});

/* ══ Approval ═══════════════════════════════════════════════════════════ */

describe("approvePlan", () => {
  it("approves; a repeat is idempotent; concurrent approvals agree", async () => {
    const v = await created(singleDraft());
    const s = await svc();
    const [a, b] = await Promise.all([s.approvePlan(AUTH, v.planId), s.approvePlan(AUTH, v.planId)]);
    expect(a.state).toBe("approved");
    expect(b.state).toBe("approved");
    expect((await s.approvePlan(AUTH, v.planId)).approved).toBe(true);
  });
  it("late approval and approval after abandonment are NOT_APPROVABLE; executes nothing", async () => {
    const s = await svc();
    const v = await created(singleDraft());
    vi.setSystemTime(T0 + 31 * MIN);
    expect(await code(s.approvePlan(AUTH, v.planId))).toBe("NOT_APPROVABLE");
    vi.setSystemTime(T0);
    const w = await created(singleDraft("intent_svc_00002"));
    await s.abandonPlan(AUTH, w.planId);
    expect(await code(s.approvePlan(AUTH, w.planId))).toBe("NOT_APPROVABLE");
    expect(ctl.quoteCalls).toHaveLength(0);
    expect(ctl.buildCalls).toBe(0);
  });
});

/* ══ Next step ══════════════════════════════════════════════════════════ */

describe("nextStep", () => {
  it("the current step, quotable, once approved", async () => {
    const s = await svc();
    const v = await created();
    expect(await code(s.nextStep(AUTH, v.planId))).toBe("NOT_APPROVED");
    await storeApprove(v.planId);
    expect(await s.nextStep(AUTH, v.planId)).toEqual({ nodeId: "n1", ref: { protocolId: "payai-swap", actionId: "swap", version: "1.0.0" }, state: "pending", quotable: true });
  });

  it("moves on only after the dependency confirms; a submitted step isn't quotable", async () => {
    const s = await svc();
    const planId = await approved();
    const q = await s.quoteStep(AUTH, planId, "n1");
    expect((await s.nextStep(AUTH, planId))).toMatchObject({ nodeId: "n1", state: "awaiting_signature", quotable: true });
    await seedBuild(q.quoteId, S);
    const tx = txHash();
    await s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: tx });
    expect(await s.nextStep(AUTH, planId)).toMatchObject({ nodeId: "n1", state: "submitted", quotable: false, reason: "This step's transaction is waiting to settle." });
    await seedVerdict(tx, OK_VERDICT);
    await seedOutputs(q.quoteId, tx, S, SWAP_OUTPUTS());
    await s.settleStep(AUTH, planId, "n1");
    expect(await s.nextStep(AUTH, planId)).toMatchObject({ nodeId: "n2", state: "pending", quotable: true });
  });

  it.each([
    ["reverted", { verdict: { ok: false, reverted: true, message: "reverted" }, outputs: null }, "reverted"],
    ["unverified", { verdict: { ok: false, verified: false }, outputs: null }, "unverified"],
    ["confirmed without the needed output", { outputs: { tokenOut: { verified: true, type: "token", value: USDC } } }, "unverified"],
  ])("a %s dependency stops the plan: dependents are skipped, never executable", async (_l, o, state) => {
    const s = await svc();
    const planId = await approved();
    await runStep(planId, "n1", S, o as never);
    const v = await s.getPlan(AUTH, planId);
    expect(v.nodes.map((n) => n.state)).toEqual([state, "skipped"]);
    expect(v.state).toBe("failed");
    expect(await s.nextStep(AUTH, planId)).toMatchObject({ nodeId: "n1", quotable: false });
    expect(await code(s.quoteStep(AUTH, planId, "n2"))).toBe("STEP_NOT_READY");
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("STEP_NOT_READY");
  });

  it("a completed plan has no next step", async () => {
    const s = await svc();
    const planId = await approved(singleDraft());
    // A transfer has no confirmedOutputs → it can only end unverified…
    await runStep(planId, "n1", T, { outputs: null });
    expect((await s.getPlan(AUTH, planId)).nodes[0].state).toBe("unverified");
    // …while a two-step plan whose steps both verify completes.
    const p2 = await approved(sendDraft("intent_svc_00003"));
    await runStep(p2, "n1", S);
    await runStep(p2, "n2", T, { outputs: { amount: units("1") } });
    const v = await s.getPlan(AUTH, p2);
    expect(v.state).toBe("completed");
    expect(await code(s.nextStep(AUTH, p2))).toBe("STEP_NOT_READY");
  });

  it("expired plans are EXPIRED; abandoned plans have nothing quotable", async () => {
    const s = await svc();
    const planId = await approved();
    const p2 = await approved(sendDraft("intent_svc_00004"));
    await s.abandonPlan(AUTH, p2);
    expect(await code(s.nextStep(AUTH, p2))).toBe("STEP_NOT_READY");
    vi.setSystemTime(T0 + 7 * DAY);
    expect(await code(s.nextStep(AUTH, planId))).toBe("EXPIRED"); // core retained through the 24h grace
    expect(await code(s.nextStep(OTHER, planId))).toBe("NOT_FOUND");
  });
});

/* ══ Quote ══════════════════════════════════════════════════════════════ */

describe("quoteStep", () => {
  it("quotes through the canonical SDK helper, records the attempt (hash only) and returns the token once", async () => {
    const s = await svc();
    const planId = await approved();
    const q = await s.quoteStep(AUTH, planId, "n1");
    expect(q).toMatchObject({ nodeId: "n1", attempt: 1, inputs: { tokenOut: USDC, amountIn: "100000000000000000000" }, summary: "swap quote", risk: { level: "low" }, warnings: ["fine"] });
    expect(q.quoteId).toMatch(/^[0-9a-f]{32}$/);
    // It is a real SDK quote token, bound to this action and these inputs.
    const { verifyQuoteToken } = await import("@/lib/sdk/quoteToken");
    expect(verifyQuoteToken(q.quoteToken, { protocolId: "payai-swap", actionId: "swap", version: "1.0.0", chainId: 143 }, q.inputs as ActionInputs)).toMatchObject({ ok: true, quoteId: q.quoteId });
    // Stored: the hash, never the token.
    const dump = await rawStoreDump();
    expect(dump).not.toContain(q.quoteToken);
    expect(dump).toContain(createHash("sha256").update(q.quoteToken).digest("hex"));
    expect(JSON.stringify(await s.getPlan(AUTH, planId))).not.toContain(createHash("sha256").update(q.quoteToken).digest("hex"));
    expect(ctl.buildCalls).toBe(0);
  });

  it("resolves inputs from CONFIRMED outputs, the pins and the live fee (fee on top)", async () => {
    const s = await svc();
    const planId = await approved(payoutDraft());
    await runStep(planId, "n1", S, { outputs: SWAP_OUTPUTS("100000000") });
    const q = await s.quoteStep(AUTH, planId, "n2");
    expect(q.inputs).toEqual({ token: USDC, recipients: [
      { recipient: ALICE, amount: "20000000" },
      { recipient: BOB, amount: "79750624" }, // largest R: (20 + R) + floor((20 + R) * 25 / 10000) ≤ 100 USDC
    ] });
    ctl.feeBps = 10;
    const q2 = await s.quoteStep(AUTH, planId, "n2");
    expect((q2.inputs.recipients as { amount: string }[])[1].amount).toBe("79900100");
  });

  it("fee-rate drift between resolution and quote is QUOTE_REFUSED and nothing is recorded", async () => {
    const s = await svc();
    const planId = await approved(payoutDraft());
    await runStep(planId, "n1", S);
    ctl.quoteFeeBps = 30;
    expect(await code(s.quoteStep(AUTH, planId, "n2"))).toBe("QUOTE_REFUSED");
    expect((await s.getPlan(AUTH, planId)).nodes[1].quoteAttempts).toBe(0);
    ctl.feeBps = null; ctl.quoteFeeBps = null;
    expect(await code(s.quoteStep(AUTH, planId, "n2"))).toBe("QUOTE_REFUSED"); // fee unavailable: never a guessed rate
  });

  it("SDK refusals are QUOTE_REFUSED with nothing recorded: input error, policy block, validation", async () => {
    const s = await svc();
    const planId = await approved();
    ctl.quoteThrows = "input";
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("QUOTE_REFUSED");
    ctl.quoteThrows = null;
    ctl.policy = { allowed: false, reason: "Sanctioned recipient." };
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("QUOTE_REFUSED");
    ctl.policy = null;
    ctl.quoteThrows = "internal";
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("THREW:engine down"); // internal failures aren't masked
    ctl.quoteThrows = null;
    expect((await s.getPlan(AUTH, planId)).nodes[0].quoteAttempts).toBe(0);
    expect((await s.quoteStep(AUTH, planId, "n1")).attempt).toBe(1);
  });

  it("at most 8 attempts; each new quote is a new attempt", async () => {
    const s = await svc();
    const planId = await approved();
    for (let n = 1; n <= 8; n++) expect((await s.quoteStep(AUTH, planId, "n1")).attempt).toBe(n);
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("CONFLICT");
    expect(ctl.quoteCalls).toHaveLength(8); // the 9th never reached the SDK
  });

  it("concurrent quotes: one attempt wins, the other is CONFLICT (no internal retry)", async () => {
    const s = await svc();
    const planId = await approved();
    const res = await Promise.allSettled([s.quoteStep(AUTH, planId, "n1"), s.quoteStep(AUTH, planId, "n1")]);
    expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("CONFLICT");
    expect((await s.getPlan(AUTH, planId)).nodes[0].quoteAttempts).toBe(1);
  });

  it("refused when not approved, abandoned, expired, for a non-current or unknown node", async () => {
    const s = await svc();
    const v = await created();
    expect(await code(s.quoteStep(AUTH, v.planId, "n1"))).toBe("NOT_APPROVED");
    await storeApprove(v.planId);
    expect(await code(s.quoteStep(AUTH, v.planId, "n2"))).toBe("STEP_NOT_READY");
    expect(await code(s.quoteStep(AUTH, v.planId, "n9"))).toBe("INVALID_NODE");
    await s.abandonPlan(AUTH, v.planId);
    expect(await code(s.quoteStep(AUTH, v.planId, "n1"))).toBe("STEP_NOT_READY");
    const p2 = await approved(sendDraft("intent_svc_00005"));
    vi.setSystemTime(T0 + 7 * DAY);
    expect(await code(s.quoteStep(AUTH, p2, "n1"))).toBe("EXPIRED");
    expect(ctl.quoteCalls).toHaveLength(0);
  });
});

/* ══ Bind ═══════════════════════════════════════════════════════════════ */

describe("bindQuote", () => {
  it("accepts the node's latest token while fresh; repeatable; writes nothing", async () => {
    const s = await svc();
    const planId = await approved();
    const q = await s.quoteStep(AUTH, planId, "n1");
    const before = await rawStoreDump();
    const b = await s.bindQuote(AUTH, planId, "n1", q.quoteToken);
    expect(b).toEqual({ nodeId: "n1", ref: q.ref, attempt: 1, quoteId: q.quoteId, quotedAt: T0, freshUntil: T0 + 90_000 });
    expect(await s.bindQuote(AUTH, planId, "n1", q.quoteToken)).toEqual(b);
    expect(await rawStoreDump()).toBe(before);
  });

  it("refuses a wrong token, a superseded one, another node's or plan's, and a stale quote", async () => {
    const s = await svc();
    const planId = await approved();
    const q1 = await s.quoteStep(AUTH, planId, "n1");
    const q2 = await s.quoteStep(AUTH, planId, "n1");
    expect(await code(s.bindQuote(AUTH, planId, "n1", q1.quoteToken))).toBe("NOT_FOUND"); // superseded
    expect(await code(s.bindQuote(AUTH, planId, "n1", `${q2.quoteToken}x`))).toBe("NOT_FOUND");
    expect(await code(s.bindQuote(AUTH, planId, "n1", 42))).toBe("NOT_FOUND");
    expect(await code(s.bindQuote(AUTH, planId, "n2", q2.quoteToken))).toBe("STEP_NOT_READY");
    const other = await approved(sendDraft("intent_svc_00006"));
    expect(await code(s.bindQuote(AUTH, other, "n1", q2.quoteToken))).toBe("NOT_FOUND");
    vi.setSystemTime(T0 + 90_001);
    expect(await code(s.bindQuote(AUTH, planId, "n1", q2.quoteToken))).toBe("EXPIRED");
  });
});

/* ══ Transaction ════════════════════════════════════════════════════════ */

describe("recordTx", () => {
  async function quoted() {
    const s = await svc();
    const planId = await approved();
    const q = await s.quoteStep(AUTH, planId, "n1");
    return { s, planId, q };
  }

  it("records a submission backed by the SDK build record for this quote, wallet and action", async () => {
    const { s, planId, q } = await quoted();
    await seedBuild(q.quoteId, S);
    const tx = txHash();
    const v = await s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: tx });
    expect(v.nodes[0]).toMatchObject({ state: "submitted", txHash: tx, result: null });
    expect(v.state).toBe("running");
    expect(await s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: tx })).toEqual(v); // idempotent
    expect(await code(s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: txHash() }))).toBe("CONFLICT");
  });

  it.each([
    ["no build record", async () => {}],
    ["a build for another wallet", (q: string) => seedBuild(q, S, OTHER_WALLET)],
    ["a build for another action", (q: string) => seedBuild(q, T)],
    ["a build for another version", (q: string) => seedBuild(q, ["payai-swap", "swap", "1.0.1"])],
  ])("%s → NOT_FOUND, nothing recorded", async (_l, seed) => {
    const { s, planId, q } = await quoted();
    await seed(q.quoteId);
    expect(await code(s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: txHash() }))).toBe("NOT_FOUND");
    expect((await s.getPlan(AUTH, planId)).nodes[0].txHash).toBeNull();
  });

  it("an unapproved plan can't take a transaction (NOT_APPROVED)", async () => {
    const s = await svc();
    const v = await created();
    const store = await import("@/lib/plan/store");
    // A quote can't exist without approval through the service; seed one directly.
    await store.recordQuote(v.planId, "n1", { attempt: 1, quoteId: "c".repeat(32), quoteToken: "t.s", inputsHash: "a".repeat(64), termsHash: "b".repeat(64), quotedAt: T0 },
      { sessionWallet: WALLET, activeChainId: 143 });
    await seedBuild("c".repeat(32), S);
    expect(await code(s.recordTx(AUTH, v.planId, "n1", { quoteId: "c".repeat(32), txHash: txHash() }))).toBe("NOT_APPROVED");
  });

  it("refuses an unknown quote, a malformed hash, an unready node, and an expired plan", async () => {
    const { s, planId, q } = await quoted();
    await seedBuild(q.quoteId, S);
    expect(await code(s.recordTx(AUTH, planId, "n1", { quoteId: "f".repeat(32), txHash: txHash() }))).toBe("NOT_FOUND");
    expect(await code(s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: "0x12" }))).toBe("INVALID_PLAN");
    expect(await code(s.recordTx(AUTH, planId, "n2", { quoteId: q.quoteId, txHash: txHash() }))).toBe("STEP_NOT_READY");
    expect(await code(s.recordTx(AUTH, planId, "n7", { quoteId: q.quoteId, txHash: txHash() }))).toBe("INVALID_NODE");
    vi.setSystemTime(T0 + 7 * DAY);
    expect(await code(s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: txHash() }))).toBe("EXPIRED");
  });

  it("concurrent conflicting submissions: one wins", async () => {
    const { s, planId, q } = await quoted();
    await seedBuild(q.quoteId, S);
    const res = await Promise.allSettled([
      s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: txHash() }),
      s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: txHash() }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("after abandonment, a transaction already signed can still be recorded and settled", async () => {
    const { s, planId, q } = await quoted();
    await seedBuild(q.quoteId, S);
    await s.abandonPlan(AUTH, planId);
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("STEP_NOT_READY");
    const tx = txHash();
    await s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: tx });
    await seedVerdict(tx, OK_VERDICT);
    await seedOutputs(q.quoteId, tx, S, SWAP_OUTPUTS());
    expect(await s.nextStep(AUTH, planId)).toMatchObject({ nodeId: "n1", state: "submitted", quotable: false, reason: "This plan was abandoned." });
    const v = await s.settleStep(AUTH, planId, "n1");
    expect(v.nodes.map((n) => n.state)).toEqual(["confirmed", "skipped"]);
    expect(v.state).toBe("partial");
  });
});

/* ══ Settlement ═════════════════════════════════════════════════════════ */

describe("settleStep — server-side records only", () => {
  async function submitted() {
    const s = await svc();
    const planId = await approved();
    const q = await s.quoteStep(AUTH, planId, "n1");
    await seedBuild(q.quoteId, S);
    const tx = txHash();
    await s.recordTx(AUTH, planId, "n1", { quoteId: q.quoteId, txHash: tx });
    return { s, planId, q, tx };
  }

  it("no confirm verdict yet → SETTLEMENT_PENDING, nothing written", async () => {
    const { s, planId } = await submitted();
    expect(await code(s.settleStep(AUTH, planId, "n1"))).toBe("SETTLEMENT_PENDING");
    expect((await s.getPlan(AUTH, planId)).nodes[0].result).toBeNull();
  });

  it("confirmed verdict + the quote-bound Stage 2 output record → confirmed, outputs copied exactly", async () => {
    const { s, planId, q, tx } = await submitted();
    await seedVerdict(tx, OK_VERDICT);
    await seedOutputs(q.quoteId, tx, S, SWAP_OUTPUTS("4190000"));
    const v = await s.settleStep(AUTH, planId, "n1");
    expect(v.nodes[0]).toMatchObject({ state: "confirmed", result: { status: "confirmed", outputs: SWAP_OUTPUTS("4190000") } });
    expect(await s.settleStep(AUTH, planId, "n1")).toEqual(v); // replay is idempotent
  });

  it.each([
    ["no output record (e.g. an action without confirmedOutputs)", async () => {}],
    ["an output record for another quote", (q: string, tx: string) => seedOutputs("a".repeat(32), tx, S, SWAP_OUTPUTS())],
    ["the quote's outputs already recorded for another transaction", (q: string) => seedOutputs(q, txHash(), S, SWAP_OUTPUTS())],
    ["an output record for another wallet", (q: string, tx: string) => seedOutputs(q, tx, S, SWAP_OUTPUTS(), OTHER_WALLET)],
    ["an output record for another action", (q: string, tx: string) => seedOutputs(q, tx, T, SWAP_OUTPUTS())],
    ["an output record for another version", (q: string, tx: string) => seedOutputs(q, tx, ["payai-swap", "swap", "1.0.1"], SWAP_OUTPUTS())],
  ])("a success verdict with %s → unverified, no outputs", async (_l, seed) => {
    const { s, planId, q, tx } = await submitted();
    await seedVerdict(tx, OK_VERDICT);
    await seed(q.quoteId, tx);
    const v = await s.settleStep(AUTH, planId, "n1");
    expect(v.nodes[0]).toMatchObject({ state: "unverified", result: { status: "unverified", outputs: null } });
  });

  it.each([
    ["reverted", { ok: false, reverted: true, message: "x" }, "reverted"],
    ["unverified", { ok: false, verified: false, message: "x" }, "unverified"],
    ["malformed", { weird: true }, "unverified"],
    ["half-success", { ok: true }, "unverified"],
    ["contradictory", { ok: true, reverted: true }, "unverified"],
  ])("a %s verdict → %s, no outputs (even if an output record exists)", async (_l, verdict, status) => {
    const { s, planId, q, tx } = await submitted();
    await seedVerdict(tx, verdict);
    await seedOutputs(q.quoteId, tx, S, SWAP_OUTPUTS());
    const v = await s.settleStep(AUTH, planId, "n1");
    expect(v.nodes[0].result).toEqual({ status, outputs: null });
  });

  it("a verdict stored for another transaction doesn't settle this one", async () => {
    const { s, planId } = await submitted();
    await seedVerdict(txHash(), OK_VERDICT);
    expect(await code(s.settleStep(AUTH, planId, "n1"))).toBe("SETTLEMENT_PENDING");
  });

  it("confirmed but missing an output a later step needs → unverified (the store's rule)", async () => {
    const { s, planId, q, tx } = await submitted();
    await seedVerdict(tx, OK_VERDICT);
    await seedOutputs(q.quoteId, tx, S, { tokenOut: { verified: true, type: "token", value: USDC } });
    expect((await s.settleStep(AUTH, planId, "n1")).nodes[0].state).toBe("unverified");
  });

  it("a settled result outlives the 24h SDK records: settling again returns it", async () => {
    const { s, planId, q, tx } = await submitted();
    await seedVerdict(tx, OK_VERDICT);
    await seedOutputs(q.quoteId, tx, S, SWAP_OUTPUTS());
    const v = await s.settleStep(AUTH, planId, "n1");
    vi.setSystemTime(T0 + DAY + MIN); // sdk-settle / sdk-outputs have expired
    expect((await s.settleStep(AUTH, planId, "n1")).nodes[0]).toEqual(v.nodes[0]);
  });

  it("no transaction → NOT_FOUND; concurrent settlements agree", async () => {
    const s = await svc();
    const planId = await approved();
    expect(await code(s.settleStep(AUTH, planId, "n1"))).toBe("NOT_FOUND");
    const p = await submitted();
    await seedVerdict(p.tx, OK_VERDICT);
    await seedOutputs(p.q.quoteId, p.tx, S, SWAP_OUTPUTS());
    const [a, b] = await Promise.all([p.s.settleStep(AUTH, p.planId, "n1"), p.s.settleStep(AUTH, p.planId, "n1")]);
    expect(a.nodes[0]).toEqual(b.nodes[0]);
  });

  it("client-injected status or outputs have no way in", async () => {
    const { s, planId, tx } = await submitted();
    await seedVerdict(tx, { ok: false, verified: false });
    // The API takes no status/outputs: extra arguments are ignored.
    const settle = s.settleStep as unknown as (...a: unknown[]) => Promise<import("@/lib/plan/service").PlanView>;
    const v = await settle(AUTH, planId, "n1", { status: "confirmed", outputs: SWAP_OUTPUTS("999999999") });
    expect(v.nodes[0].result).toEqual({ status: "unverified", outputs: null });
    expect(s.settleStep.length).toBe(3);
  });
});

/* ══ Abandon / list ═════════════════════════════════════════════════════ */

describe("abandonPlan and listPlans", () => {
  it("abandon is idempotent, keeps facts, blocks approval and quotes", async () => {
    const s = await svc();
    const planId = await approved();
    await s.quoteStep(AUTH, planId, "n1");
    const a = await s.abandonPlan(AUTH, planId);
    expect(a).toMatchObject({ abandoned: true, approved: true, state: "failed" });
    expect(a.nodes[0].quoteAttempts).toBe(1);
    expect(await s.abandonPlan(AUTH, planId)).toEqual(a);
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("STEP_NOT_READY");
  });

  it("lists the wallet's plans newest first, capped, excluding others' and broken entries", async () => {
    const s = await svc();
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      vi.setSystemTime(T0 + i * 1000);
      ids.push((await created(sendDraft(`intent_svc_list${String(i).padStart(3, "0")}`))).planId);
    }
    const list = await s.listPlans(AUTH);
    expect(list).toHaveLength(20);
    expect(list.map((p) => p.planId)).toEqual(ids.slice(-20).reverse());
    expect(list[0]).toEqual({ planId: ids[21], state: "planned", currentStep: "n1", steps: 2, createdAt: T0 + 21_000, expiresAt: T0 + 21_000 + 7 * DAY });
    // A corrupt plan is skipped.
    const { planKeys, __putRawForTests } = await import("@/lib/plan/store");
    __putRawForTests(planKeys.core(ids[21]), "{oops");
    expect((await s.listPlans(AUTH)).map((p) => p.planId)).not.toContain(ids[21]);
    expect(await s.listPlans(OTHER)).toEqual([]);
  });
});

/* ══ Security ═══════════════════════════════════════════════════════════ */

describe("security", () => {
  it("views never carry raw records, keys, token hashes or terms hashes", async () => {
    const s = await svc();
    const planId = await approved(payoutDraft());
    const { q } = await runStep(planId, "n1", S);
    const q2 = await s.quoteStep(AUTH, planId, "n2");
    const json = JSON.stringify([await s.getPlan(AUTH, planId), await s.listPlans(AUTH), await s.nextStep(AUTH, planId)]);
    for (const bad of ["veripay:", "quoteTokenHash", "termsHash", "inputsHash", "graphHash", "draft", q.quoteToken, q2.quoteToken,
      createHash("sha256").update(q2.quoteToken).digest("hex")]) expect(json.includes(bad), bad).toBe(false);
  });

  it("the service and the quote helper import nothing that signs, broadcasts, builds, or calls an LLM", () => {
    for (const f of ["lib/plan/service.ts", "lib/sdk/preview.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const bad of ["signTransaction", "signMessage", "sendTransaction", "sendRawTransaction", "writeContract", "privateKey",
        "createWalletClient", "getPublicClient", "encodeFunctionData", "anthropic", "openai", "fetch(", ".build(", "@/lib/monad/wallet"]) {
        expect(src.includes(bad), `${f} contains ${bad}`).toBe(false);
      }
    }
    expect(ctl.buildCalls).toBe(0);
  });

  it("the SDK build function is never reached by a full plan run", async () => {
    const planId = await approved(payoutDraft());
    await runStep(planId, "n1", S);
    await runStep(planId, "n2", P, { outputs: { recipientAmounts: { verified: true, type: "units[]", value: ["20000000", "79750624"], token: USDC } } });
    const s = await svc();
    expect((await s.getPlan(AUTH, planId)).state).toBe("completed");
    expect(ctl.buildCalls).toBe(0);
  });
});

/* ══ A1: the preview route uses the same helper ════════════════════════ */

describe("A1 — canonical quote helper", () => {
  it("the preview route delegates to quoteAction and no longer issues tokens itself", () => {
    const route = readFileSync(join(process.cwd(), "app/api/ask/action/route.ts"), "utf8");
    expect(route).toContain('import("@/lib/sdk/preview")');
    expect(route).not.toContain("issueQuoteToken");
    expect(route).not.toContain("validateForQuote");
    expect(route).not.toContain("enforcePaymentPolicy");
  });

  it("quoteAction: validation codes, policy block, and an issued token for valid inputs", async () => {
    const { quoteAction } = await import("@/lib/sdk/preview");
    expect(await quoteAction({ protocolId: "nope", actionId: "x", version: "1.0.0" }, {})).toMatchObject({ ok: false, code: "PROTOCOL_NOT_CONFIGURED" });
    expect(await quoteAction({ protocolId: "payai-swap", actionId: "swap", version: "9.9.9" }, {})).toMatchObject({ ok: false, code: "VERSION_MISMATCH" });
    expect(await quoteAction({ protocolId: "payai-swap", actionId: "swap", version: "1.0.0" }, { tokenOut: USDC })).toMatchObject({ ok: false });
    ctl.policy = { allowed: false };
    expect(await quoteAction({ protocolId: "payai-swap", actionId: "swap", version: "1.0.0" }, { tokenOut: USDC, amountIn: "1" })).toEqual({ ok: false, code: "POLICY_BLOCKED", message: "This payment can't be made." });
    ctl.policy = null;
    const r = await quoteAction({ protocolId: "payai-swap", actionId: "swap", version: "1.0.0" }, { tokenOut: USDC, amountIn: "1" });
    expect(r).toMatchObject({ ok: true, inputs: { tokenOut: USDC, amountIn: "1" }, quote: { summary: "swap quote" } });
    if (r.ok) expect(r.quoteToken.length).toBeGreaterThan(10);
    expect(ctl.buildCalls).toBe(0);
  });
});

/* ══ Phase 4A: quoteId in the view; the pending-build guard ═════════════ */

describe("Phase 4A — node quoteId for recovery", () => {
  it("null before any quote; the latest attempt's id while quoting; the RECORDED transaction's id once submitted", async () => {
    const s = await svc();
    const planId = await approved();
    expect((await s.getPlan(AUTH, planId)).nodes.map((n) => n.quoteId)).toEqual([null, null]);
    const q1 = await s.quoteStep(AUTH, planId, "n1");
    expect((await s.getPlan(AUTH, planId)).nodes[0].quoteId).toBe(q1.quoteId);
    const q2 = await s.quoteStep(AUTH, planId, "n1"); // no build yet → not held back
    expect((await s.getPlan(AUTH, planId)).nodes[0].quoteId).toBe(q2.quoteId);
    // The transaction was built from attempt 1: the view names attempt 1, not the latest.
    await seedBuild(q1.quoteId, S);
    const tx = txHash();
    const v = await s.recordTx(AUTH, planId, "n1", { quoteId: q1.quoteId, txHash: tx });
    expect(v.nodes[0]).toMatchObject({ quoteId: q1.quoteId, txHash: tx, state: "submitted" });
  });

  it("is only the random id: the node view carries no token, token hash, terms/inputs hash or key", async () => {
    const s = await svc();
    const planId = await approved();
    const q = await s.quoteStep(AUTH, planId, "n1");
    const v = await s.getPlan(AUTH, planId);
    expect(Object.keys(v.nodes[0]).sort()).toEqual(["dependsOn", "nodeId", "quoteAttempts", "quoteId", "ref", "result", "state", "txHash"]);
    expect(v.nodes[0].quoteId).toMatch(/^[0-9a-f]{32}$/);
    const json = JSON.stringify(v);
    for (const bad of [q.quoteToken, createHash("sha256").update(q.quoteToken).digest("hex"), "quoteTokenHash", "termsHash", "inputsHash", "veripay:"]) {
      expect(json.includes(bad), bad).toBe(false);
    }
  });
});

describe("Phase 4A — pending-build guard in quoteStep", () => {
  it("a fresh build on the latest attempt (no transaction) holds new quotes back for exactly 2 minutes — no SDK quote, no attempt", async () => {
    const s = await svc();
    const planId = await approved();
    const q1 = await s.quoteStep(AUTH, planId, "n1");
    await seedBuild(q1.quoteId, S); // builtAt = T0
    const calls = ctl.quoteCalls.length;
    vi.setSystemTime(T0 + 119_999);
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("STEP_NOT_READY");
    expect(ctl.quoteCalls.length).toBe(calls); // the SDK was never asked to quote
    expect((await s.getPlan(AUTH, planId)).nodes[0].quoteAttempts).toBe(1);
    vi.setSystemTime(T0 + 120_000);
    const q2 = await s.quoteStep(AUTH, planId, "n1");
    expect(q2.attempt).toBe(2);
  });

  it("no build on the latest attempt → quotes freely (re-quoting a stale, unbuilt quote is unaffected)", async () => {
    const s = await svc();
    const planId = await approved();
    for (let n = 1; n <= 3; n++) expect((await s.quoteStep(AUTH, planId, "n1")).attempt).toBe(n);
  });

  it("only the LATEST attempt matters: an older attempt's build doesn't hold back a later re-quote", async () => {
    const s = await svc();
    const planId = await approved();
    const q1 = await s.quoteStep(AUTH, planId, "n1");
    await seedBuild(q1.quoteId, S);
    vi.setSystemTime(T0 + 2 * 60_000);
    await s.quoteStep(AUTH, planId, "n1"); // attempt 2, not built
    expect((await s.quoteStep(AUTH, planId, "n1")).attempt).toBe(3);
    // …and the inverse: an unbuilt earlier attempt doesn't clear a fresh build on the latest one.
    const p2 = await approved(sendDraft("intent_svc_4a002"));
    await s.quoteStep(AUTH, p2, "n1"); // attempt 1, never built
    const latest = await s.quoteStep(AUTH, p2, "n1"); // attempt 2
    await seedBuild(latest.quoteId, S);
    expect(await code(s.quoteStep(AUTH, p2, "n1"))).toBe("STEP_NOT_READY");
  });

  it("any build blocks (whoever built it), and a malformed builtAt falls back to the quote's own record time", async () => {
    const s = await svc();
    const planId = await approved();
    const q1 = await s.quoteStep(AUTH, planId, "n1");
    await seedBuild(q1.quoteId, S, OTHER_WALLET);
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("STEP_NOT_READY");

    const p2 = await approved(sendDraft("intent_svc_4a001"));
    const qa = await s.quoteStep(AUTH, p2, "n1");
    const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
    const { buildKey } = await import("@/lib/sdk/settlement");
    await claimRequest(buildKey(qa.quoteId));
    await completeRequest(buildKey(qa.quoteId), { protocolId: S[0], actionId: S[1], version: S[2], wallet: WALLET, builtAt: "yesterday" });
    vi.setSystemTime(T0 + 60_000);
    expect(await code(s.quoteStep(AUTH, p2, "n1"))).toBe("STEP_NOT_READY");
    vi.setSystemTime(T0 + 120_000);
    expect((await s.quoteStep(AUTH, p2, "n1")).attempt).toBe(2);
  });

  it("a FUTURE builtAt is malformed: it can't extend the window — the quote's own record time is used (exact 120,000 ms boundary)", async () => {
    const s = await svc();
    const planId = await approved();
    const q1 = await s.quoteStep(AUTH, planId, "n1"); // quote recorded at T0
    const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
    const { buildKey } = await import("@/lib/sdk/settlement");
    await claimRequest(buildKey(q1.quoteId));
    await completeRequest(buildKey(q1.quoteId), { protocolId: S[0], actionId: S[1], version: S[2], wallet: WALLET, builtAt: T0 + 24 * 60 * 60_000 });
    vi.setSystemTime(T0 + 119_999);
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("STEP_NOT_READY"); // still within the quote-time window
    vi.setSystemTime(T0 + 120_000);
    expect((await s.quoteStep(AUTH, planId, "n1")).attempt).toBe(2); // NOT held until T0 + 1 day + 2 min
  });

  it("is per node, not a plan lock: the next node quotes immediately after the previous one settles", async () => {
    const s = await svc();
    const planId = await approved();
    await runStep(planId, "n1", S); // built + recorded + confirmed at T0
    expect((await s.quoteStep(AUTH, planId, "n2")).attempt).toBe(1);
  });

  it("concurrent runners: once one has built, the other's quote is refused instead of producing a second transaction", async () => {
    const s = await svc();
    const planId = await approved();
    const a = await s.quoteStep(AUTH, planId, "n1");
    await s.bindQuote(AUTH, planId, "n1", a.quoteToken);
    await seedBuild(a.quoteId, S); // runner A built; its wallet is now prompting
    // Runner B tries to start its own attempt for the same step.
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("STEP_NOT_READY");
    // Runner A records its transaction; the step is now submitted, never re-quotable.
    await s.recordTx(AUTH, planId, "n1", { quoteId: a.quoteId, txHash: txHash() });
    expect(await code(s.quoteStep(AUTH, planId, "n1"))).toBe("STEP_NOT_READY");
    expect((await s.getPlan(AUTH, planId)).nodes[0]).toMatchObject({ state: "submitted", quoteAttempts: 1, quoteId: a.quoteId });
  });
});
