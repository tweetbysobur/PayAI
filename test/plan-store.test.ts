import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, ProtocolAdapter } from "@/lib/sdk/types";

/**
 * Phase 2C Stage 3A — the durable Plan Store (lib/plan/store.ts) and derived
 * plan state (lib/plan/state.ts).
 *
 * Every storage test runs twice: against a KV stand-in that honours
 * SET NX EX + sorted sets, and against the in-memory fallback. The real
 * registry is used (MONAD_NETWORK=mainnet → split_payment 2.0.0), plus the
 * same TEST-ONLY transfer/swap fixtures as test/plan-planner.test.ts, whose
 * quote/build/parseResult are spies that must never be called.
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
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ── KV stand-in ───────────────────────────────────────────────────────── */

const kv = vi.hoisted(() => ({
  enabled: false,
  failIndex: false,
  store: new Map<string, { v: string; exp: number }>(),
  z: new Map<string, Map<string, number>>(),
  sets: [] as { key: string; opts?: { nx?: boolean; ex?: number } }[],
  expires: [] as { key: string; seconds: number }[],
  /** Test-only: awaited at the start of every SET (to interleave concurrent writers). */
  beforeSet: undefined as ((key: string) => Promise<void>) | undefined,
}));
vi.mock("@/lib/platform/kv", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/platform/kv")>();
  const live = (key: string) => {
    const e = kv.store.get(key);
    if (e && e.exp <= Date.now()) { kv.store.delete(key); return undefined; }
    return e;
  };
  const fake = {
    async get(key: string) {
      const e = live(key);
      if (!e) return null;
      try { return JSON.parse(e.v); } catch { return e.v; } // Upstash returns non-JSON as a string
    },
    async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
      if (kv.beforeSet) await kv.beforeSet(key);
      kv.sets.push({ key, opts });
      if (opts?.nx && live(key)) return null;
      kv.store.set(key, { v: JSON.stringify(value), exp: opts?.ex ? Date.now() + opts.ex * 1000 : Infinity });
      return "OK";
    },
    async del(key: string) { kv.store.delete(key); return 1; },
    async expire(key: string, seconds: number) { kv.expires.push({ key, seconds }); return 1; },
    async zadd(key: string, e: { score: number; member: string }) {
      if (kv.failIndex) throw new Error("index down");
      if (!kv.z.has(key)) kv.z.set(key, new Map());
      kv.z.get(key)!.set(e.member, e.score);
      return 1;
    },
    async zrange(key: string) {
      if (kv.failIndex) throw new Error("index down");
      return [...(kv.z.get(key) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    },
  };
  return { ...actual, getRedis: async () => (kv.enabled ? fake : null), kvEnabled: () => kv.enabled };
});

/* ── Registry fixtures ─────────────────────────────────────────────────── */

const spies = { quote: vi.fn(), build: vi.fn(), parseResult: vi.fn() };
const neverCalled = (name: keyof typeof spies) => async (...a: unknown[]): Promise<never> => {
  spies[name](...a);
  throw new Error(`fixture: ${name} must not be called`);
};
function fixture(protocolId: string, action: Omit<Action, "protocolId" | "chainId" | "allowedTargets" | "quote" | "build" | "parseResult">): ProtocolAdapter {
  const target = "0x00000000000000000000000000000000000000f1" as const;
  return {
    protocolId, name: `${protocolId} (test fixture)`, chainId: 143, allowedTargets: [target],
    actions: [{ ...action, protocolId, chainId: 143, allowedTargets: [target], quote: neverCalled("quote"), build: neverCalled("build"), parseResult: neverCalled("parseResult") } as Action],
  };
}
const TRANSFER = fixture("payai", {
  actionId: "transfer", version: "1.0.0", name: "Transfer", description: "test fixture",
  inputSchema: {
    recipient: { type: "address", required: true, description: "to" },
    token: { type: "token", required: false, description: "token" },
    amount: { type: "units", required: true, description: "amount" },
  },
});
const swapFixture = (version: string) => fixture("payai-swap", {
  actionId: "swap", version, name: "Swap", description: "test fixture",
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

async function registry(swapVersion = "1.0.0") {
  const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
  registerProtocol(TRANSFER);
  registerProtocol(swapFixture(swapVersion));
}

let savedNetwork: string | undefined;
beforeEach(async () => {
  savedNetwork = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  Object.values(spies).forEach((s) => s.mockClear());
  kv.enabled = false; kv.failIndex = false; kv.store.clear(); kv.z.clear(); kv.sets.length = 0; kv.expires.length = 0; kv.beforeSet = undefined;
  (await import("@/lib/plan/store")).__resetPlanStoreForTests();
  await registry();
});
afterEach(() => {
  if (savedNetwork === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = savedNetwork;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/* ── Builders ──────────────────────────────────────────────────────────── */

type Ref = [string, string, string];
const T: Ref = ["payai", "transfer", "1.0.0"];
const S: Ref = ["payai-swap", "swap", "1.0.0"];
const SPLIT: Ref = ["payai-settlement", "split_payment", "2.0.0"];
const lit = (value: string) => ({ kind: "literal", value });
const out = (node: string, output: string) => ({ kind: "output", node, output });
const rem = (node: string, output: string, minus: string[]) => ({ kind: "remainder", node, output, minus });
const addr = (a: string) => ({ kind: "recipient", display: a, source: "address", address: a });
const payee = (name: string) => ({ kind: "recipient", display: name, source: "payee" });
function node(nodeId: string, ref: Ref, inputs: Record<string, unknown>, dependsOn: string[] = []) {
  return {
    nodeId, ref: { protocolId: ref[0], actionId: ref[1], version: ref[2] }, inputs, dependsOn,
    validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
  };
}
function graph(nodes: unknown[], text: string, id = "intent_store_0001") {
  return { id, version: 1, chainId: 143, wallet: WALLET, nodes, status: "draft", source: { text, adapter: "deterministic", adapterVersion: "1" } };
}
const swapNode = () => node("n1", S, { tokenOut: lit(USDC), amountIn: lit("100000000000000000000") });
const sendDraft = (id?: string) => graph([
  swapNode(),
  node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "amountOut") }, ["n1"]),
], `swap 100 MON to USDC and send the USDC to ${RECIPIENT}`, id);
const SPLIT_TEXT = "swap 100 MON to USDC, send 20 USDC to Alice and the rest to Bob";
const splitDraft = () => graph([
  swapNode(),
  node("n2", SPLIT, { token: lit(USDC), recipients: { kind: "list", items: [
    { recipient: payee("Alice"), amount: lit("20000000") },
    { recipient: payee("Bob"), amount: rem("n1", "amountOut", ["20000000"]) },
  ] } }, ["n1"]),
], SPLIT_TEXT);
const PINS = { "payee:alice": ALICE, "payee:bob": BOB };

const CTX = () => ({ sessionWallet: WALLET, activeChainId: 143 });
async function lib() {
  return { ...(await import("@/lib/plan/store")), ...(await import("@/lib/plan/state")), ...(await import("@/lib/plan/validate")), ...(await import("@/lib/plan/planner")) };
}
async function planned(raw: unknown) {
  const { validateIntentGraph, planIntent } = await lib();
  const v = validateIntentGraph(raw, { sessionWallet: WALLET, activeChainId: 143 });
  if (!v.ok) throw new Error(JSON.stringify(v.error));
  return { graph: v.value, plan: planIntent(v.value, { sessionWallet: WALLET }) };
}
async function create(raw: unknown = sendDraft(), pins: Record<string, string> = {}) {
  const { createPlan } = await lib();
  const { graph: g, plan } = await planned(raw);
  return createPlan(g, plan, pins, CTX());
}
async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try { await (typeof p === "function" ? p() : p); } catch (e) { return (e as { code?: string }).code ?? `THREW:${(e as Error).message}`; }
  return "OK";
}
const QID = (n: number) => n.toString(16).padStart(32, "0");
const H = (c: string) => c.repeat(64);
const quoteInput = (attempt = 1, o: Partial<{ quoteId: string; quoteToken: string; inputsHash: string; termsHash: string; quotedAt: number }> = {}) => ({
  attempt, quoteId: QID(attempt), quoteToken: `token-${attempt}.sig`, inputsHash: H("a"), termsHash: H("b"), quotedAt: T0, ...o,
});
const TX = (c: string) => `0x${c.repeat(64)}`;
const units = (value: string, token = USDC) => ({ verified: true as const, type: "units" as const, value, token });

/** Put a raw value at a key, under whichever backend is active (test-only). */
async function putRaw(key: string, value: unknown) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (kv.enabled) kv.store.set(key, { v: raw, exp: Date.now() + 7 * DAY });
  else (await import("@/lib/plan/store")).__putRawForTests(key, raw);
}
async function getRaw(key: string): Promise<Record<string, unknown>> {
  if (kv.enabled) return JSON.parse(kv.store.get(key)!.v);
  const g = globalThis as unknown as { __payaiPlanStore: { kv: Map<string, { json: string }> } };
  return JSON.parse(g.__payaiPlanStore.kv.get(key)!.json);
}

/** Drive a plan to "n1 confirmed with outputs". */
async function confirmN1(planId: string, amountOut = "99000000") {
  const { approvePlan, recordQuote, recordTx, recordResult } = await lib();
  await approvePlan(planId, CTX());
  await recordQuote(planId, "n1", quoteInput(1), CTX());
  await recordTx(planId, "n1", { quoteId: QID(1), txHash: TX("1") }, CTX());
  return recordResult(planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "confirmed", outputs: { amountOut: units(amountOut), tokenOut: { verified: true, type: "token", value: USDC } } }, CTX());
}

/* ══ Storage (both backends) ═══════════════════════════════════════════ */

describe.each([["KV", true], ["in-memory fallback", false]])("Plan Store (%s)", (_label, useKv) => {
  beforeEach(() => { kv.enabled = useKv as boolean; });

  describe("PlanCore", () => {
    it("creates a plan bound to the planner's planId, graphHash, wallet, chain and step order, with persisted timestamps", async () => {
      const { graph: g, plan } = await planned(sendDraft());
      const { createPlan, planKeys } = await lib();
      const { core, created } = await createPlan(g, plan, {}, CTX());
      expect(created).toBe(true);
      expect(core).toMatchObject({
        v: 1, planId: plan.planId, graphHash: plan.graphHash, wallet: WALLET, chainId: 143,
        pins: {}, stepOrder: ["n1", "n2"], createdAt: T0, approveBy: T0 + 30 * MIN, expiresAt: T0 + 7 * DAY,
      });
      expect(core.planId).toMatch(/^plan_[0-9a-f]{32}$/);
      expect(await getRaw(planKeys.core(core.planId))).toEqual(core);
    });

    it("the stored draft is canonical draft form: status draft, every node state pending, same graphHash", async () => {
      const { core } = await create();
      const { graphHash, validateIntentGraph } = await lib();
      expect(core.draft.status).toBe("draft");
      for (const n of core.draft.nodes as { validation: unknown; execution: unknown; verification: unknown }[]) {
        expect(n).toMatchObject({ validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" } });
      }
      expect(core.draft).not.toHaveProperty("order");
      expect(core.draft).not.toHaveProperty("boundOutputs");
      const re = validateIntentGraph(core.draft, { sessionWallet: WALLET, activeChainId: 143 });
      expect(re.ok && graphHash(re.value)).toBe(core.graphHash);
    });

    it("timestamps are persisted, never regenerated on read", async () => {
      const { core } = await create();
      vi.setSystemTime(T0 + 5 * HOUR);
      const { loadPlan } = await lib();
      const l = await loadPlan(core.planId, CTX());
      expect(l.core).toMatchObject({ createdAt: T0, approveBy: T0 + 30 * MIN, expiresAt: T0 + 7 * DAY });
    });

    it("the core is written once and retained 7 days + a 24h grace (index too); it expires at 7 days", async () => {
      const { core } = await create();
      const { planKeys, loadPlan } = await lib();
      if (useKv) {
        expect(kv.sets.filter((s) => s.key === planKeys.core(core.planId))).toEqual([{ key: planKeys.core(core.planId), opts: { nx: true, ex: 8 * 24 * 3600 } }]);
        expect(kv.expires.filter((e) => e.key === planKeys.byWallet(WALLET))).toEqual([{ key: planKeys.byWallet(WALLET), seconds: 8 * 24 * 3600 }]);
      } else {
        const g = globalThis as unknown as { __payaiPlanStore: { kv: Map<string, { expiresAt: number }>; idx: Map<string, { expiresAt: number }> } };
        expect(g.__payaiPlanStore.kv.get(planKeys.core(core.planId))!.expiresAt).toBe(T0 + 8 * DAY);
        expect(g.__payaiPlanStore.idx.get(planKeys.byWallet(WALLET))!.expiresAt).toBe(T0 + 8 * DAY);
      }
      expect(core.expiresAt).toBe(T0 + 7 * DAY); // the plan's lifetime is unchanged
      vi.setSystemTime(T0 + 7 * DAY - 1);
      expect(await code(loadPlan(core.planId, CTX()))).toBe("OK");
      vi.setSystemTime(T0 + 7 * DAY);
      expect(await code(loadPlan(core.planId, CTX()))).toBe("EXPIRED");
    });

    it("during the grace the OWNER reads EXPIRED, another wallet NOT_FOUND (like a missing plan); after it, NOT_FOUND for all", async () => {
      const { core } = await create();
      const { loadPlan, readPlanCore } = await lib();
      const missing = `plan_${"7".repeat(32)}`;
      for (const t of [T0 + 7 * DAY, T0 + 7 * DAY + 12 * 60 * MIN, T0 + 8 * DAY - 1]) {
        vi.setSystemTime(t);
        expect(await code(readPlanCore(core.planId, CTX()))).toBe("EXPIRED");
        expect(await code(loadPlan(core.planId, CTX()))).toBe("EXPIRED");
        expect(await code(loadPlan(core.planId, { ...CTX(), sessionWallet: OTHER_WALLET }))).toBe("NOT_FOUND");
        expect(await code(loadPlan(missing, CTX()))).toBe("NOT_FOUND");
      }
      vi.setSystemTime(T0 + 8 * DAY);
      expect(await code(loadPlan(core.planId, CTX()))).toBe("NOT_FOUND");
      expect(await code(loadPlan(core.planId, { ...CTX(), sessionWallet: OTHER_WALLET }))).toBe("NOT_FOUND");
    });

    it("facts are NOT retained: they still expire at expiresAt, only the core outlives it", async () => {
      const { core } = await create();
      const { approvePlan, recordQuote, abandonPlan, planKeys } = await lib();
      await approvePlan(core.planId, CTX());
      await recordQuote(core.planId, "n1", quoteInput(1), CTX());
      await abandonPlan(core.planId, CTX());
      const factKeys = [planKeys.approved(core.planId), planKeys.quote(core.planId, "n1", 1), planKeys.abandoned(core.planId)];
      if (useKv) for (const k of factKeys) expect(kv.sets.find((x) => x.key === k)?.opts, k).toEqual({ nx: true, ex: 7 * 24 * 3600 });
      vi.setSystemTime(T0 + 7 * DAY);
      const present = async (k: string) => useKv
        ? (await (await import("@/lib/platform/kv")).getRedis())!.get(k).then((v) => v !== null)
        : (globalThis as unknown as { __payaiPlanStore: { kv: Map<string, { expiresAt: number }> } }).__payaiPlanStore.kv.get(k)!.expiresAt > Date.now();
      for (const k of factKeys) expect(await present(k), k).toBe(false);
      expect(await present(planKeys.core(core.planId))).toBe(true);
    });

    it("documented change: an identical draft can't re-create its plan during the grace (EXPIRED); it can after", async () => {
      const first = await create();
      vi.setSystemTime(T0 + 7 * DAY + MIN);
      expect(await code(create())).toBe("EXPIRED"); // the retained expired core still occupies its planId
      vi.setSystemTime(T0 + 8 * DAY);
      const again = await create();
      expect(again.created).toBe(true);
      expect(again.core.planId).toBe(first.core.planId);
      expect(again.core.createdAt).toBe(T0 + 8 * DAY);
    });

    it("an identical create is idempotent (original timestamps); a conflicting one is CONFLICT and never overwrites", async () => {
      const first = await create(splitDraft(), PINS);
      vi.setSystemTime(T0 + 10 * MIN);
      const again = await create(splitDraft(), PINS);
      expect(again.created).toBe(false);
      expect(again.core).toEqual(first.core);
      expect(await code(create(splitDraft(), { "payee:alice": BOB, "payee:bob": ALICE }))).toBe("CONFLICT");
      const { loadPlan } = await lib();
      expect((await loadPlan(first.core.planId, CTX())).core.pins).toEqual(PINS);
    });

    it("concurrent identical creates: exactly one writes, both get the same core", async () => {
      const [a, b] = await Promise.all([create(), create()]);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(a.core).toEqual(b.core);
    });

    it("only a validator-produced graph and its own plan can be stored, for the session's wallet", async () => {
      const { createPlan, planIntent } = await lib();
      const { graph: g, plan } = await planned(sendDraft());
      expect(await code(createPlan(JSON.parse(JSON.stringify(g)), plan, {}, CTX()))).toBe("UNVALIDATED_GRAPH");
      expect(await code(createPlan(g, JSON.parse(JSON.stringify(plan)), {}, CTX()))).toBe("INVALID_PLAN");
      const other = await planned(sendDraft("intent_store_0002"));
      expect(await code(createPlan(g, other.plan, {}, CTX()))).toBe("GRAPH_MUTATION");
      expect(await code(createPlan(g, planIntent(g, { sessionWallet: WALLET }), {}, { ...CTX(), sessionWallet: OTHER_WALLET }))).toBe("WALLET_MISMATCH");
    });
  });

  describe("pinned recipients", () => {
    it("exact pins are stored lowercase and authoritative", async () => {
      const { core } = await create(splitDraft(), { "payee:alice": ALICE.toUpperCase().replace("0X", "0x"), "payee:bob": BOB });
      expect(core.pins).toEqual(PINS);
    });
    it.each([
      ["missing pin", { "payee:alice": ALICE }],
      ["extra pin", { ...PINS, "payee:carol": ALICE }],
      ["zero-address pin", { ...PINS, "payee:bob": ZERO }],
      ["malformed address", { ...PINS, "payee:bob": "0x1234" }],
      ["wrong source key", { "nad:alice": ALICE, "payee:bob": BOB }],
    ])("%s → RECIPIENT_UNRESOLVED, nothing stored", async (_l, pins) => {
      expect(await code(create(splitDraft(), pins as Record<string, string>))).toBe("RECIPIENT_UNRESOLVED");
      const { readPlanCore, planIntent, validateIntentGraph } = await lib();
      const v = validateIntentGraph(splitDraft(), { sessionWallet: WALLET, activeChainId: 143 });
      const id = v.ok ? planIntent(v.value, { sessionWallet: WALLET }).planId : "";
      expect(await code(readPlanCore(id, CTX()))).toBe("NOT_FOUND");
    });
    it("a typed 0x address needs no pin (and can't be given one)", async () => {
      expect(await code(create(sendDraft(), {}))).toBe("OK");
      expect(await code(create(sendDraft("intent_store_0003"), { [`address:${RECIPIENT}`]: RECIPIENT }))).toBe("RECIPIENT_UNRESOLVED");
    });
  });

  describe("rehydration", () => {
    it("re-establishes a trusted graph and plan that match the stored core", async () => {
      const { core } = await create(splitDraft(), PINS);
      const { loadPlan, isValidatedIntentGraph, isExecutionPlan } = await lib();
      const l = await loadPlan(core.planId, CTX());
      expect(isValidatedIntentGraph(l.graph)).toBe(true);
      expect(isExecutionPlan(l.plan)).toBe(true);
      expect(l.plan.planId).toBe(core.planId);
      expect(l.shape).toEqual({ stepOrder: ["n1", "n2"], dependsOn: { n1: [], n2: ["n1"] } });
    });

    const tamper = async (f: (c: Record<string, unknown>) => void) => {
      const { core } = await create(splitDraft(), PINS);
      const { planKeys, loadPlan } = await lib();
      const raw = await getRaw(planKeys.core(core.planId));
      f(raw);
      await putRaw(planKeys.core(core.planId), raw);
      return code(loadPlan(core.planId, CTX()));
    };
    it.each([
      ["draft amount", (c: Record<string, unknown>) => { ((c.draft as { nodes: { inputs: { amountIn: { value: string } } }[] }).nodes[0].inputs.amountIn).value = "1"; }],
      ["draft recipient", (c: Record<string, unknown>) => { (c.draft as { nodes: { inputs: { recipients: { items: { recipient: { display: string } }[] } } }[] }).nodes[1].inputs.recipients.items[0].recipient.display = "Bob"; }],
      ["graphHash", (c: Record<string, unknown>) => { c.graphHash = "0".repeat(64); }],
      ["stepOrder", (c: Record<string, unknown>) => { c.stepOrder = ["n2", "n1"]; }],
      ["pins (extra)", (c: Record<string, unknown>) => { c.pins = { ...PINS, "payee:carol": ALICE }; }],
      ["pins (missing)", (c: Record<string, unknown>) => { c.pins = { "payee:alice": ALICE }; }],
      ["draft status", (c: Record<string, unknown>) => { (c.draft as { status: string }).status = "running"; }],
      ["chainId", (c: Record<string, unknown>) => { c.chainId = 1; }],
      ["expiry extended", (c: Record<string, unknown>) => { c.expiresAt = (c.expiresAt as number) + DAY; }],
      ["approveBy extended", (c: Record<string, unknown>) => { c.approveBy = (c.approveBy as number) + DAY; }],
      ["unknown version", (c: Record<string, unknown>) => { c.v = 2; }],
      ["extra field", (c: Record<string, unknown>) => { c.state = "completed"; }],
      ["malformed timestamp", (c: Record<string, unknown>) => { c.createdAt = "yesterday"; }],
    ])("tampered %s → CORRUPT", async (_l, f) => {
      expect(await tamper(f)).toBe("CORRUPT");
    });

    it("planId tampering → CORRUPT (record under a key it doesn't belong to)", async () => {
      const { core } = await create(splitDraft(), PINS);
      const { planKeys, loadPlan } = await lib();
      const raw = await getRaw(planKeys.core(core.planId));
      const fake = `plan_${"e".repeat(32)}`;
      await putRaw(planKeys.core(fake), raw);
      expect(await code(loadPlan(fake, CTX()))).toBe("CORRUPT");
      raw.planId = fake;
      await putRaw(planKeys.core(fake), raw);
      expect(await code(loadPlan(fake, CTX()))).toBe("CORRUPT"); // re-planning gives the real id
    });

    it("wallet tampering → CORRUPT for the new owner; the real owner can't read it either", async () => {
      const { core } = await create(splitDraft(), PINS);
      const { planKeys, loadPlan } = await lib();
      const raw = await getRaw(planKeys.core(core.planId));
      raw.wallet = OTHER_WALLET;
      await putRaw(planKeys.core(core.planId), raw);
      expect(await code(loadPlan(core.planId, { ...CTX(), sessionWallet: OTHER_WALLET }))).toBe("CORRUPT");
      expect(await code(loadPlan(core.planId, CTX()))).toBe("NOT_FOUND");
    });

    it("malformed JSON / wrong shapes at the plan key → CORRUPT", async () => {
      const { planKeys, loadPlan } = await lib();
      const id = `plan_${"d".repeat(32)}`;
      for (const raw of ["{not json", "42", "null-ish", JSON.stringify([1, 2])]) {
        await putRaw(planKeys.core(id), raw);
        expect(await code(loadPlan(id, CTX())), raw).toBe("CORRUPT");
      }
    });

    it("a registry/action version change after planning fails closed", async () => {
      const { core } = await create();
      await registry("1.0.1");
      const { loadPlan } = await lib();
      expect(await code(loadPlan(core.planId, CTX()))).toBe("CORRUPT");
      await registry("1.0.0");
      expect(await code(loadPlan(core.planId, CTX()))).toBe("OK");
    });

    it("another wallet sees NOT_FOUND (existence isn't disclosed); invalid ids are NOT_FOUND; wrong chain is CORRUPT", async () => {
      const { core } = await create();
      const { loadPlan } = await lib();
      expect(await code(loadPlan(core.planId, { ...CTX(), sessionWallet: OTHER_WALLET }))).toBe("NOT_FOUND");
      expect(await code(loadPlan(core.planId, { ...CTX(), sessionWallet: null }))).toBe("NOT_FOUND");
      expect(await code(loadPlan("plan_xyz", CTX()))).toBe("NOT_FOUND");
      expect(await code(loadPlan(`plan_${"f".repeat(32)}`, CTX()))).toBe("NOT_FOUND");
      expect(await code(loadPlan(core.planId, { ...CTX(), activeChainId: 10143 }))).toBe("CORRUPT");
    });

    it("rehydration never writes", async () => {
      const { core } = await create();
      const before = kv.sets.length;
      const { loadPlan } = await lib();
      await loadPlan(core.planId, CTX());
      expect(kv.sets.length).toBe(before);
    });
  });

  describe("approval", () => {
    it("approves once within the window; identical repeat is idempotent; stored until expiresAt", async () => {
      const { core } = await create();
      const { approvePlan, planKeys, loadPlan } = await lib();
      vi.setSystemTime(T0 + 10 * MIN);
      const a = await approvePlan(core.planId, CTX());
      expect(a).toEqual({ planId: core.planId, graphHash: core.graphHash, wallet: WALLET, approvedAt: T0 + 10 * MIN });
      vi.setSystemTime(T0 + 20 * MIN);
      expect(await approvePlan(core.planId, CTX())).toEqual(a);
      if (useKv) expect(kv.sets.find((s) => s.key === planKeys.approved(core.planId))?.opts).toEqual({ nx: true, ex: (7 * DAY - 10 * MIN) / 1000 });
      vi.setSystemTime(T0 + 3 * DAY); // long after the 30-minute window: still approved
      expect((await loadPlan(core.planId, CTX())).facts.approval).toEqual(a);
    });

    it("late approval → NOT_APPROVABLE", async () => {
      const { core } = await create();
      const { approvePlan } = await lib();
      vi.setSystemTime(T0 + 30 * MIN + 1);
      expect(await code(approvePlan(core.planId, CTX()))).toBe("NOT_APPROVABLE");
    });

    it("a conflicting stored approval → CONFLICT; a malformed one → CORRUPT", async () => {
      const { core } = await create();
      const { approvePlan, planKeys } = await lib();
      await putRaw(planKeys.approved(core.planId), { planId: core.planId, graphHash: "0".repeat(64), wallet: WALLET, approvedAt: T0 });
      expect(await code(approvePlan(core.planId, CTX()))).toBe("CORRUPT"); // graphHash disagrees with the core
      const { core: c2 } = await create(sendDraft("intent_store_0009"));
      await putRaw(planKeys.approved(c2.planId), { planId: c2.planId, graphHash: c2.graphHash, wallet: WALLET });
      expect(await code(approvePlan(c2.planId, CTX()))).toBe("CORRUPT");
    });

    it("concurrent approvals: both succeed with the same stored approval", async () => {
      const { core } = await create();
      const { approvePlan } = await lib();
      const [a, b] = await Promise.all([approvePlan(core.planId, CTX()), approvePlan(core.planId, CTX())]);
      expect(a).toEqual(b);
    });
  });

  describe("quote attempts", () => {
    it("stores attempt 1 with the token's SHA-256 — never the token", async () => {
      const { core } = await create();
      const { recordQuote, planKeys } = await lib();
      const q = await recordQuote(core.planId, "n1", quoteInput(1, { quoteToken: "SECRET-QUOTE-TOKEN.abc" }), CTX());
      const { createHash } = await import("node:crypto");
      expect(q.quoteTokenHash).toBe(createHash("sha256").update("SECRET-QUOTE-TOKEN.abc").digest("hex"));
      const raw = JSON.stringify(await getRaw(planKeys.quote(core.planId, "n1", 1)));
      expect(raw).not.toContain("SECRET-QUOTE-TOKEN");
      expect(Object.keys(q).sort()).toEqual(["attempt", "inputsHash", "nodeId", "planId", "quoteId", "quoteTokenHash", "quotedAt", "recordedAt", "termsHash"]);
    });

    it("same attempt: identical → idempotent; different → CONFLICT; concurrent conflicting writers → one wins", async () => {
      const { core } = await create();
      const { recordQuote } = await lib();
      const q = await recordQuote(core.planId, "n1", quoteInput(1), CTX());
      vi.setSystemTime(T0 + MIN);
      expect(await recordQuote(core.planId, "n1", quoteInput(1), CTX())).toEqual(q);
      expect(await code(recordQuote(core.planId, "n1", quoteInput(1, { quoteToken: "other" }), CTX()))).toBe("CONFLICT");
      const res = await Promise.allSettled([
        recordQuote(core.planId, "n2", quoteInput(1, { quoteId: QID(91) }), CTX()),
        recordQuote(core.planId, "n2", quoteInput(1, { quoteId: QID(92) }), CTX()),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("CONFLICT");
    });

    it("attempts are numbered in order from 1, and bounded at 8", async () => {
      const { core } = await create();
      const { recordQuote, loadPlan, nextQuoteAttempt } = await lib();
      expect(await code(recordQuote(core.planId, "n1", quoteInput(2), CTX()))).toBe("INVALID_PLAN");
      expect(await code(recordQuote(core.planId, "n1", quoteInput(0), CTX()))).toBe("INVALID_PLAN");
      for (let n = 1; n <= 8; n++) {
        expect(nextQuoteAttempt(await loadPlan(core.planId, CTX()), "n1")).toBe(n);
        await recordQuote(core.planId, "n1", quoteInput(n), CTX());
      }
      expect(await code(recordQuote(core.planId, "n1", quoteInput(9), CTX()))).toBe("CONFLICT");
      expect((await loadPlan(core.planId, CTX())).facts.nodes.n1.quotes.map((q) => q.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("rejects malformed quote fields and unknown nodes", async () => {
      const { core } = await create();
      const { recordQuote } = await lib();
      expect(await code(recordQuote(core.planId, "n1", quoteInput(1, { quoteId: "xyz" }), CTX()))).toBe("INVALID_PLAN");
      expect(await code(recordQuote(core.planId, "n1", quoteInput(1, { inputsHash: "abc" }), CTX()))).toBe("INVALID_PLAN");
      expect(await code(recordQuote(core.planId, "n1", quoteInput(1, { quoteToken: "" }), CTX()))).toBe("INVALID_PLAN");
      expect(await code(recordQuote(core.planId, "n1", quoteInput(1, { quoteToken: "x".repeat(2049) }), CTX()))).toBe("INVALID_PLAN");
      expect(await code(recordQuote(core.planId, "n9", quoteInput(1), CTX()))).toBe("INVALID_NODE");
      expect(await code(recordQuote(core.planId, "Bad Node", quoteInput(1), CTX()))).toBe("INVALID_NODE");
    });
  });

  describe("transactions", () => {
    it("must reference one of this node's quotes; written once; different hash → CONFLICT; wallet is the plan's", async () => {
      const { core } = await create();
      const { recordQuote, recordTx } = await lib();
      expect(await code(recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("1") }, CTX()))).toBe("NOT_FOUND");
      await recordQuote(core.planId, "n1", quoteInput(1), CTX());
      await recordQuote(core.planId, "n2", quoteInput(1, { quoteId: QID(77) }), CTX());
      expect(await code(recordTx(core.planId, "n1", { quoteId: QID(77), txHash: TX("1") }, CTX()))).toBe("NOT_FOUND"); // n2's quote
      const t = await recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("A") }, CTX());
      expect(t).toMatchObject({ txHash: TX("a"), wallet: WALLET, quoteId: QID(1) });
      expect(await recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("a") }, CTX())).toEqual(t);
      expect(await code(recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("2") }, CTX()))).toBe("CONFLICT");
      expect(await code(recordTx(core.planId, "n1", { quoteId: QID(1), txHash: "0x12" }, CTX()))).toBe("INVALID_PLAN");
    });

    it("concurrent conflicting transaction writers: exactly one wins", async () => {
      const { core } = await create();
      const { recordQuote, recordTx } = await lib();
      await recordQuote(core.planId, "n1", quoteInput(1), CTX());
      const res = await Promise.allSettled([
        recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("3") }, CTX()),
        recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("4") }, CTX()),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    });

    it("execution facts live until the plan expires — not 24 hours", async () => {
      const { core } = await create();
      const { recordQuote, recordTx, recordResult, loadPlan, deriveNodeStates, planKeys } = await lib();
      await confirmN1(core.planId);
      vi.setSystemTime(T0 + DAY);
      await recordQuote(core.planId, "n2", quoteInput(1, { quoteId: QID(5) }), CTX());
      await recordTx(core.planId, "n2", { quoteId: QID(5), txHash: TX("5") }, CTX());
      await recordResult(core.planId, "n2", { quoteId: QID(5), txHash: TX("5"), status: "confirmed", outputs: null }, CTX());
      if (useKv) expect(kv.sets.find((s) => s.key === planKeys.tx(core.planId, "n2"))?.opts).toEqual({ nx: true, ex: 6 * 24 * 3600 });
      vi.setSystemTime(T0 + 6 * DAY);
      const l = await loadPlan(core.planId, CTX());
      expect(deriveNodeStates(l.shape, l.facts)).toEqual({ n1: "confirmed", n2: "confirmed" });
    });
  });

  describe("results", () => {
    it("must match the stored transaction; written once; conflicting → CONFLICT", async () => {
      const { core } = await create();
      const { approvePlan, recordQuote, recordTx, recordResult } = await lib();
      await approvePlan(core.planId, CTX());
      await recordQuote(core.planId, "n1", quoteInput(1), CTX());
      expect(await code(recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "confirmed", outputs: null }, CTX()))).toBe("NOT_FOUND");
      await recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("1") }, CTX());
      expect(await code(recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("9"), status: "reverted", outputs: null }, CTX()))).toBe("CONFLICT");
      expect(await code(recordResult(core.planId, "n1", { quoteId: QID(2), txHash: TX("1"), status: "reverted", outputs: null }, CTX()))).toBe("CONFLICT");
      const r = await recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "reverted", outputs: null }, CTX());
      expect(r.status).toBe("reverted");
      expect(await recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "reverted", outputs: null }, CTX())).toEqual(r);
      expect(await code(recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "unverified", outputs: null }, CTX()))).toBe("CONFLICT");
    });

    it("a confirmed result missing an output a later step needs is stored as unverified", async () => {
      const { core } = await create();
      const { approvePlan, recordQuote, recordTx, recordResult } = await lib();
      await approvePlan(core.planId, CTX());
      await recordQuote(core.planId, "n1", quoteInput(1), CTX());
      await recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("1") }, CTX());
      const r = await recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "confirmed", outputs: { tokenOut: { verified: true, type: "token", value: USDC } } }, CTX());
      expect(r.status).toBe("unverified");
      expect(r.outputs).toEqual({ tokenOut: { verified: true, type: "token", value: USDC } });
    });

    it("a confirmed result with the needed outputs stays confirmed; invalid outputs are refused", async () => {
      const { core } = await create();
      const r = await confirmN1(core.planId);
      expect(r.status).toBe("confirmed");
      const { core: c2 } = await create(sendDraft("intent_store_0004"));
      const { approvePlan, recordQuote, recordTx, recordResult } = await lib();
      await approvePlan(c2.planId, CTX());
      await recordQuote(c2.planId, "n1", quoteInput(1), CTX());
      await recordTx(c2.planId, "n1", { quoteId: QID(1), txHash: TX("1") }, CTX());
      for (const outputs of [
        { amountOut: { ...units("1"), verified: false } }, { amountOut: units("1.5") }, { amountOut: units("1", USDC.toUpperCase()) }, {},
      ]) expect(await code(recordResult(c2.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "confirmed", outputs: outputs as never }, CTX())), JSON.stringify(outputs)).toBe("INVALID_PLAN");
      expect(await code(recordResult(c2.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "reverted", outputs: { amountOut: units("1") } }, CTX()))).toBe("INVALID_PLAN");
      expect(await code(recordResult(c2.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "done" as never, outputs: null }, CTX()))).toBe("INVALID_PLAN");
    });

    it("concurrent conflicting result writers: exactly one wins", async () => {
      const { core } = await create();
      const { approvePlan, recordQuote, recordTx, recordResult } = await lib();
      await approvePlan(core.planId, CTX());
      await recordQuote(core.planId, "n1", quoteInput(1), CTX());
      await recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("1") }, CTX());
      const res = await Promise.allSettled([
        recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "reverted", outputs: null }, CTX()),
        recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "unverified", outputs: null }, CTX()),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    });
  });

  describe("abandonment", () => {
    it("written once (idempotent repeat); blocks new approvals and quotes; tx/result still recorded", async () => {
      const { core } = await create();
      const { approvePlan, abandonPlan, recordQuote, recordTx, recordResult, loadPlan, derivePlanState } = await lib();
      await approvePlan(core.planId, CTX());
      await recordQuote(core.planId, "n1", quoteInput(1), CTX());
      const a = await abandonPlan(core.planId, CTX());
      vi.setSystemTime(T0 + MIN);
      expect(await abandonPlan(core.planId, CTX())).toEqual(a);
      expect(await code(recordQuote(core.planId, "n1", quoteInput(2), CTX()))).toBe("CONFLICT");
      expect(await code(recordQuote(core.planId, "n2", quoteInput(1), CTX()))).toBe("CONFLICT");
      // The user had already signed: the chain is authoritative.
      await recordTx(core.planId, "n1", { quoteId: QID(1), txHash: TX("1") }, CTX());
      await recordResult(core.planId, "n1", { quoteId: QID(1), txHash: TX("1"), status: "confirmed", outputs: { amountOut: units("5"), tokenOut: { verified: true, type: "token", value: USDC } } }, CTX());
      const l = await loadPlan(core.planId, CTX());
      expect(derivePlanState(l.shape, l.facts)).toBe("partial");
    });

    it("approval after abandonment → NOT_APPROVABLE", async () => {
      const { core } = await create();
      const { abandonPlan, approvePlan } = await lib();
      await abandonPlan(core.planId, CTX());
      expect(await code(approvePlan(core.planId, CTX()))).toBe("NOT_APPROVABLE");
    });
  });

  describe("malformed and misplaced facts fail closed", () => {
    it.each([
      ["quote for another plan", (id: string) => ["quote", { planId: `plan_${"0".repeat(32)}`, nodeId: "n1", attempt: 1, quoteId: QID(1), quoteTokenHash: H("c"), inputsHash: H("a"), termsHash: H("b"), quotedAt: T0, recordedAt: T0 }, id]],
      ["quote for another node", (id: string) => ["quote", { planId: id, nodeId: "n2", attempt: 1, quoteId: QID(1), quoteTokenHash: H("c"), inputsHash: H("a"), termsHash: H("b"), quotedAt: T0, recordedAt: T0 }, id]],
      ["quote with the wrong attempt number", (id: string) => ["quote", { planId: id, nodeId: "n1", attempt: 2, quoteId: QID(1), quoteTokenHash: H("c"), inputsHash: H("a"), termsHash: H("b"), quotedAt: T0, recordedAt: T0 }, id]],
      ["quote carrying a raw token", (id: string) => ["quote", { planId: id, nodeId: "n1", attempt: 1, quoteId: QID(1), quoteToken: "x", quoteTokenHash: H("c"), inputsHash: H("a"), termsHash: H("b"), quotedAt: T0, recordedAt: T0 }, id]],
      ["tx without its quote", (id: string) => ["tx", { planId: id, nodeId: "n1", quoteId: QID(1), txHash: TX("1"), wallet: WALLET, submittedAt: T0 }, id]],
      ["result with an unknown status", (id: string) => ["result", { planId: id, nodeId: "n1", quoteId: QID(1), txHash: TX("1"), status: "done", outputs: null, recordedAt: T0 }, id]],
      ["result without a tx", (id: string) => ["result", { planId: id, nodeId: "n1", quoteId: QID(1), txHash: TX("1"), status: "confirmed", outputs: null, recordedAt: T0 }, id]],
      ["abandonment by another wallet", (id: string) => ["abandoned", { planId: id, wallet: OTHER_WALLET, abandonedAt: T0 }, id]],
      ["non-JSON garbage", (id: string) => ["abandoned", "{oops", id]],
    ] as const)("%s → CORRUPT on load", async (_l, mk) => {
      const { core } = await create();
      const { planKeys, loadPlan } = await lib();
      const [kind, value] = mk(core.planId) as [string, unknown];
      const key = kind === "quote" ? planKeys.quote(core.planId, "n1", 1)
        : kind === "tx" ? planKeys.tx(core.planId, "n1")
          : kind === "result" ? planKeys.result(core.planId, "n1")
            : planKeys.abandoned(core.planId);
      await putRaw(key, value);
      expect(await code(loadPlan(core.planId, CTX()))).toBe("CORRUPT");
    });

    it("a write onto a malformed fact is CORRUPT and never repairs it", async () => {
      const { core } = await create();
      const { planKeys, abandonPlan } = await lib();
      // Malformed approval: loading refuses before anything is written.
      await putRaw(planKeys.approved(core.planId), "{oops");
      expect(await code(abandonPlan(core.planId, CTX()))).toBe("CORRUPT");
      expect(kv.enabled ? kv.store.get(planKeys.approved(core.planId))!.v : "{oops").toBe("{oops");
    });

    it("creating onto a malformed core key is CORRUPT and leaves it untouched", async () => {
      const { planKeys, createPlan } = await lib();
      const { graph: g, plan } = await planned(sendDraft());
      await putRaw(planKeys.core(plan.planId), "{oops");
      expect(await code(createPlan(g, plan, {}, CTX()))).toBe("CORRUPT");
      expect(kv.enabled ? kv.store.get(planKeys.core(plan.planId))!.v : "{oops").toBe("{oops");
      if (!kv.enabled) {
        const gm = globalThis as unknown as { __payaiPlanStore: { kv: Map<string, { json: string }> } };
        expect(gm.__payaiPlanStore.kv.get(planKeys.core(plan.planId))!.json).toBe("{oops");
      }
    });

    it("an expired plan refuses reads and writes", async () => {
      const { core } = await create();
      const { loadPlan, abandonPlan, readPlanCore } = await lib();
      // The core is retained through the grace period, so the owner sees EXPIRED.
      vi.setSystemTime(T0 + 7 * DAY + 1);
      expect(await code(readPlanCore(core.planId, CTX()))).toBe("EXPIRED");
      expect(await code(loadPlan(core.planId, CTX()))).toBe("EXPIRED");
      expect(await code(abandonPlan(core.planId, CTX()))).toBe("EXPIRED");
    });
  });

  describe("wallet index (best effort, never trusted alone)", () => {
    it("lists the wallet's live plans newest first, loading each from its canonical key", async () => {
      const a = await create(sendDraft("intent_store_0101"));
      vi.setSystemTime(T0 + MIN);
      const b = await create(sendDraft("intent_store_0102"));
      const { listPlansForWallet } = await lib();
      expect((await listPlansForWallet(WALLET)).map((c) => c.planId)).toEqual([b.core.planId, a.core.planId]);
      expect(await listPlansForWallet(OTHER_WALLET)).toEqual([]);
      expect(await listPlansForWallet("nope")).toEqual([]);
    });

    it("skips stale, corrupt, foreign and expired index entries", async () => {
      const a = await create(sendDraft("intent_store_0201"));
      const { listPlansForWallet, planKeys } = await lib();
      const idx = planKeys.byWallet(WALLET);
      const stale = `plan_${"1".repeat(32)}`;
      const corrupt = `plan_${"2".repeat(32)}`;
      const foreign = `plan_${"3".repeat(32)}`;
      await putRaw(planKeys.core(corrupt), "{bad");
      const foreignCore = { ...(await getRaw(planKeys.core(a.core.planId))), planId: foreign, wallet: OTHER_WALLET };
      await putRaw(planKeys.core(foreign), foreignCore);
      if (kv.enabled) for (const m of [stale, corrupt, foreign, "junk"]) kv.z.get(idx)!.set(m, 1);
      else {
        const g = globalThis as unknown as { __payaiPlanStore: { idx: Map<string, { members: Map<string, number> }> } };
        for (const m of [stale, corrupt, foreign, "junk"]) g.__payaiPlanStore.idx.get(idx)!.members.set(m, 1);
      }
      expect((await listPlansForWallet(WALLET)).map((c) => c.planId)).toEqual([a.core.planId]);
      vi.setSystemTime(T0 + 7 * DAY + 1);
      expect(await listPlansForWallet(WALLET)).toEqual([]);
    });
  });
});

it("index failures never fail plan creation (KV)", async () => {
  kv.enabled = true;
  kv.failIndex = true;
  const { created, core } = await create();
  expect(created).toBe(true);
  const { listPlansForWallet, loadPlan } = await lib();
  expect(await listPlansForWallet(WALLET)).toEqual([]);
  expect(await code(loadPlan(core.planId, CTX()))).toBe("OK");
});

it("production without KV is UNAVAILABLE — never process memory", async () => {
  vi.stubEnv("NODE_ENV", "production");
  kv.enabled = false;
  const { graph: g, plan } = await planned(sendDraft());
  const { createPlan, readPlanCore, listPlansForWallet } = await lib();
  expect(await code(createPlan(g, plan, {}, CTX()))).toBe("UNAVAILABLE");
  expect(await code(readPlanCore(plan.planId, CTX()))).toBe("UNAVAILABLE");
  expect(await code(listPlansForWallet(WALLET))).toBe("UNAVAILABLE");
  const gm = globalThis as unknown as { __payaiPlanStore: { kv: Map<string, unknown> } };
  expect(gm.__payaiPlanStore.kv.size).toBe(0);
  // …and with KV, production works.
  kv.enabled = true;
  expect(await code(createPlan(g, plan, {}, CTX()))).toBe("OK");
});

it("test/dev without KV uses the in-memory store", async () => {
  kv.enabled = false;
  const { core } = await create();
  const gm = globalThis as unknown as { __payaiPlanStore: { kv: Map<string, unknown> } };
  expect([...gm.__payaiPlanStore.kv.keys()]).toContain(`veripay:plan:${core.planId}`);
});

it("keys are exactly the approved layout, and ids are validated before use", async () => {
  const { planKeys } = await lib();
  const id = `plan_${"a".repeat(32)}`;
  expect(planKeys.core(id)).toBe(`veripay:plan:${id}`);
  expect(planKeys.approved(id)).toBe(`veripay:plan:${id}:approved`);
  expect(planKeys.abandoned(id)).toBe(`veripay:plan:${id}:abandoned`);
  expect(planKeys.quote(id, "n1", 3)).toBe(`veripay:plan:${id}:node:n1:quote:3`);
  expect(planKeys.tx(id, "n1")).toBe(`veripay:plan:${id}:node:n1:tx`);
  expect(planKeys.result(id, "n1")).toBe(`veripay:plan:${id}:node:n1:result`);
  expect(planKeys.byWallet(WALLET)).toBe(`veripay:plans:by-wallet:${WALLET}`);
  expect(await code(() => planKeys.core("plan_x:approved"))).toBe("NOT_FOUND");
  expect(await code(() => planKeys.tx(id, "n1:result"))).toBe("INVALID_NODE");
  expect(await code(() => planKeys.quote(id, "n1", 9))).toBe("INVALID_PLAN");
  expect(await code(() => planKeys.byWallet(WALLET.toUpperCase()))).toBe("NOT_FOUND");
});

/* ══ Derived state (pure) ══════════════════════════════════════════════ */

describe("derived state", () => {
  type F = import("@/lib/plan/state").PlanFacts;
  const shape = { stepOrder: ["a", "b", "c", "d"], dependsOn: { a: [], b: ["a"], c: ["b"], d: [] } };
  const q = (nodeId: string) => ({ planId: "p", nodeId, attempt: 1, quoteId: QID(1), quoteTokenHash: H("c"), inputsHash: H("a"), termsHash: H("b"), quotedAt: T0, recordedAt: T0 });
  const tx = (nodeId: string) => ({ planId: "p", nodeId, quoteId: QID(1), txHash: TX("1"), wallet: WALLET, submittedAt: T0 });
  const res = (nodeId: string, status: "confirmed" | "reverted" | "unverified") => ({ planId: "p", nodeId, quoteId: QID(1), txHash: TX("1"), status, outputs: null, recordedAt: T0 });
  const facts = (o: Partial<Record<string, "quote" | "tx" | "confirmed" | "reverted" | "unverified">>, extra: Partial<F> = {}): F => {
    const nodes: Record<string, import("@/lib/plan/state").NodeFacts> = {};
    for (const id of shape.stepOrder) {
      const k = o[id];
      nodes[id] = {
        quotes: k ? [q(id)] : [],
        tx: k && k !== "quote" ? tx(id) : null,
        result: k === "confirmed" || k === "reverted" || k === "unverified" ? res(id, k) : null,
        intents: [], releases: [],
      };
    }
    return { approval: { planId: "p", graphHash: H("0"), wallet: WALLET, approvedAt: T0 }, abandoned: null, nodes, ...extra };
  };

  it("node states from facts: result → status, tx → submitted, quote (approved) → awaiting_signature, else pending", async () => {
    const { deriveNodeStates, deriveNodeState } = await lib();
    expect(deriveNodeStates(shape, facts({ a: "confirmed", b: "tx", c: "quote" }))).toEqual({ a: "confirmed", b: "submitted", c: "awaiting_signature", d: "pending" });
    expect(deriveNodeStates(shape, facts({ a: "quote" }, { approval: null })).a).toBe("pending");
    expect(deriveNodeState("d", shape, facts({ d: "unverified" }))).toBe("unverified");
    expect(() => deriveNodeState("z", shape, facts({}))).toThrow();
  });

  it("dependency skip: direct and indirect dependents of a failed/unverified node are skipped; independents aren't", async () => {
    const { deriveNodeStates } = await lib();
    expect(deriveNodeStates(shape, facts({ a: "reverted" }))).toEqual({ a: "reverted", b: "skipped", c: "skipped", d: "pending" });
    expect(deriveNodeStates(shape, facts({ a: "confirmed", b: "unverified" }))).toEqual({ a: "confirmed", b: "unverified", c: "skipped", d: "pending" });
    // A quote on a node whose dependency failed doesn't make it signable.
    expect(deriveNodeStates(shape, facts({ a: "reverted", b: "quote" })).b).toBe("skipped");
  });

  it("abandonment skips every node without a transaction; submitted ones stay submitted", async () => {
    const { deriveNodeStates } = await lib();
    const ab = { abandoned: { planId: "p", wallet: WALLET, abandonedAt: T0 } };
    expect(deriveNodeStates(shape, facts({ a: "confirmed", b: "tx", c: "quote" }, ab))).toEqual({ a: "confirmed", b: "submitted", c: "skipped", d: "skipped" });
  });

  it("plan state", async () => {
    const { derivePlanState } = await lib();
    expect(derivePlanState(shape, facts({}, { approval: null }))).toBe("planned");
    expect(derivePlanState(shape, facts({}))).toBe("approved");
    expect(derivePlanState(shape, facts({ a: "quote" }))).toBe("running");
    expect(derivePlanState(shape, facts({ a: "confirmed" }))).toBe("running");
    expect(derivePlanState(shape, facts({ a: "confirmed", b: "confirmed", c: "confirmed", d: "confirmed" }))).toBe("completed");
    expect(derivePlanState(shape, facts({ a: "confirmed", b: "reverted", d: "confirmed" }))).toBe("partial");
    expect(derivePlanState(shape, facts({ a: "reverted", d: "unverified" }))).toBe("failed");
    expect(derivePlanState(shape, facts({}, { approval: null, abandoned: { planId: "p", wallet: WALLET, abandonedAt: T0 } }))).toBe("failed");
  });

  it("currentStep: first in stored order neither confirmed nor skipped; null when none", async () => {
    const { currentStep } = await lib();
    expect(currentStep(shape, facts({}))).toBe("a");
    expect(currentStep(shape, facts({ a: "confirmed" }))).toBe("b");
    expect(currentStep(shape, facts({ a: "reverted" }))).toBe("a"); // reverted is terminal but not skipped
    expect(currentStep(shape, facts({ a: "confirmed", b: "confirmed", c: "confirmed" }))).toBe("d");
    expect(currentStep(shape, facts({ a: "confirmed", b: "confirmed", c: "confirmed", d: "confirmed" }))).toBeNull();
    expect(currentStep({ ...shape, stepOrder: ["d", "a", "b", "c"] }, facts({}))).toBe("d"); // stored order, not sorted
    // Skipped nodes are passed over: an abandoned plan with nothing in flight has no current step.
    expect(currentStep(shape, facts({ a: "confirmed" }, { abandoned: { planId: "p", wallet: WALLET, abandonedAt: T0 } }))).toBeNull();
    expect(currentStep(shape, facts({ a: "reverted", d: "confirmed" }))).toBe("a");
  });

  it("expiry is separate and never changes state", async () => {
    const { planExpiry, derivePlanState } = await lib();
    const core = { approveBy: T0 + 30 * MIN, expiresAt: T0 + 7 * DAY };
    expect(planExpiry(core, { approval: null }, T0)).toEqual({ expired: false, approvable: true });
    expect(planExpiry(core, { approval: null }, T0 + 31 * MIN)).toEqual({ expired: false, approvable: false });
    expect(planExpiry(core, { approval: null }, T0 + 7 * DAY)).toEqual({ expired: true, approvable: false });
    expect(derivePlanState(shape, facts({}, { approval: null }))).toBe("planned");
  });

  it("confirmed outputs adapter: units, token, units[] and native preserved exactly; only confirmed results", async () => {
    const { confirmedOutputsOf } = await lib();
    const f = facts({ a: "confirmed", b: "unverified" });
    (f.nodes.a as { result: { outputs: unknown } }).result.outputs = {
      amountOut: units("99000000"),
      tokenOut: { verified: true, type: "token", value: USDC },
      recipientAmounts: { verified: true, type: "units[]", value: ["1", "2"], token: USDC },
      fee: units("25000000000000000", ZERO),
    };
    (f.nodes.b as { result: { outputs: unknown } }).result.outputs = { amountOut: units("5") };
    expect(confirmedOutputsOf(f)).toEqual({ a: {
      amountOut: { verified: true, type: "units", value: "99000000", token: USDC },
      tokenOut: { verified: true, type: "token", value: USDC },
      recipientAmounts: { verified: true, type: "units[]", value: ["1", "2"], token: USDC },
      fee: { verified: true, type: "units", value: "25000000000000000", token: ZERO },
    } });
  });
});

/* ══ Planner compatibility and no side effects ═════════════════════════ */

describe("integration with Stage 1 and no execution", () => {
  it("stored results feed resolveStepInputs through the adapter; pins resolve recipients; native stays non-bindable", async () => {
    const { core } = await create(splitDraft(), PINS);
    await confirmN1(core.planId, "100000000");
    const { loadPlan, confirmedOutputsOf } = await lib();
    const { resolveStepInputs } = await import("@/lib/plan/resolve");
    const l = await loadPlan(core.planId, CTX());
    const confirmed = confirmedOutputsOf(l.facts);
    const r = resolveStepInputs({ plan: l.plan, graph: l.graph, nodeId: "n2", sessionWallet: WALLET, confirmed: confirmed as never, recipients: l.core.pins, feeBps: 25 });
    expect((r.recipients as { recipient: string; amount: string }[]).map((i) => [i.recipient.toLowerCase(), i.amount])).toEqual([[ALICE, "20000000"], [BOB, "79750624"]]);
    const native = { n1: { ...confirmed.n1, amountOut: { ...confirmed.n1.amountOut, token: ZERO } } };
    expect(() => resolveStepInputs({ plan: l.plan, graph: l.graph, nodeId: "n2", sessionWallet: WALLET, confirmed: native as never, recipients: l.core.pins, feeBps: 25 }))
      .toThrow(expect.objectContaining({ code: "NATIVE_OUTPUT_NOT_BINDABLE" }));
  });

  it("no action quote/build/parseResult is ever called by the store", async () => {
    const { core } = await create();
    await confirmN1(core.planId);
    const { loadPlan, listPlansForWallet } = await lib();
    await loadPlan(core.planId, CTX());
    await listPlansForWallet(WALLET);
    expect(spies.quote).not.toHaveBeenCalled();
    expect(spies.build).not.toHaveBeenCalled();
    expect(spies.parseResult).not.toHaveBeenCalled();
  });

  it("the store and state modules import nothing that signs, broadcasts, executes, builds calldata or calls an LLM", () => {
    const allowed: Record<string, string[]> = {
      "lib/plan/store.ts": ["server-only", "node:crypto", "viem", "@/lib/platform/kv", "@/lib/sdk/settlement", "@/lib/sdk/types", "./errors", "./planner", "./resolve", "./state", "./types", "./validate"],
      "lib/plan/state.ts": ["@/lib/sdk/types", "./types"],
    };
    for (const [f, ok] of Object.entries(allowed)) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) expect(ok, `${f} imports ${m[1]}`).toContain(m[1]);
      const code_ = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const bad of ["signTransaction", "signMessage", "sendTransaction", "sendRawTransaction", "writeContract", "privateKey", "createWalletClient",
        "encodeFunctionData", "fetch(", "anthropic", "openai", ".parseResult(", ".del("]) {
        expect(code_.includes(bad), `${f} contains ${bad}`).toBe(false);
      }
      // No action quote/build call (planKeys.quote is the key builder).
      expect(code_.match(/(?<!planKeys)\.(quote|build)\(/g), f).toBeNull();
    }
  });
});

/* ══ Stage 5C-2d follow-up — one unresolved signing intent per node, atomically ══ */

describe("signing intent slots: at most one unresolved intent per node, enforced by SET NX", () => {
  const D = (c: string) => c.repeat(64);
  async function ready() {
    const { approvePlan, recordQuote } = await lib();
    const { core } = await create();
    await approvePlan(core.planId, CTX());
    await recordQuote(core.planId, "n1", quoteInput(1), CTX());
    return core.planId;
  }

  it("THE RACE (KV): A reads, B quotes anew and writes its intent, A's stale write loses on the same slot — CONFLICT", async () => {
    kv.enabled = true;
    const { recordQuote, recordSigningIntent, loadPlan, unresolvedIntent, planKeys } = await lib();
    const planId = await ready();
    // Pause A's first intent SET until B is done.
    let paused!: () => void;
    const reached = new Promise<void>((r) => { paused = r; });
    let resume!: () => void;
    const gate = new Promise<void>((r) => { resume = r; });
    let first = true;
    kv.beforeSet = async (key) => {
      if (first && key.includes(":intent:")) { first = false; paused(); await gate; }
    };
    const a = recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX()); // A: snapshot has q1 latest, no intents
    await reached;
    await recordQuote(planId, "n1", quoteInput(2), CTX()); // B quotes attempt 2 meanwhile
    const b = await recordSigningIntent(planId, "n1", { quoteId: QID(2), buildDigest: D("b") }, CTX()); // B: writes slot 1
    expect(b).toMatchObject({ quoteId: QID(2), attempt: 2 });
    resume();
    expect(await code(a)).toBe("CONFLICT"); // A must not sign
    const f = (await loadPlan(planId, CTX())).facts.nodes.n1;
    expect(f.intents.map((i) => i.quoteId)).toEqual([QID(2)]);
    expect(unresolvedIntent(f)?.quoteId).toBe(QID(2));
    expect(kv.store.has(planKeys.intent(planId, "n1", 1))).toBe(true);
    expect(kv.store.has(planKeys.intent(planId, "n1", 2))).toBe(false);
    expect(kv.sets.filter((x) => x.key.includes(":intent:")).every((x) => x.opts?.nx === true)).toBe(true);
  });

  /**
   * Both requests read the node (no intents → slot 1) and are held just
   * before their SET NX; they are then let go in a chosen order. A is for q1
   * (read while q1 was latest), B for q2 (read after q2 was quoted).
   */
  async function forcedRace(firstToWrite: "A" | "B") {
    kv.enabled = true;
    const { recordQuote, recordSigningIntent, loadPlan, unresolvedIntent, planKeys } = await lib();
    const planId = await ready();
    const held: { key: string; go: () => void }[] = [];
    let arrived!: () => void;
    let waitFor = 0;
    let arrivals = new Promise<void>((r) => { arrived = r; });
    kv.beforeSet = async (key) => {
      if (!key.includes(":intent:")) return;
      await new Promise<void>((go) => { held.push({ key, go }); if (held.length === waitFor) arrived(); });
    };
    waitFor = 1;
    const a = recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX());
    await arrivals; // A has loaded, computed slot 1 and is held before SET NX
    await recordQuote(planId, "n1", quoteInput(2), CTX());
    arrivals = new Promise<void>((r) => { arrived = r; });
    waitFor = 2;
    const b = recordSigningIntent(planId, "n1", { quoteId: QID(2), buildDigest: D("b") }, CTX());
    await arrivals; // B has loaded, computed slot 1 and is held too
    expect(held.map((h) => h.key)).toEqual([planKeys.intent(planId, "n1", 1), planKeys.intent(planId, "n1", 1)]);
    const [winner, loser] = firstToWrite === "A" ? [a, b] : [b, a];
    held[firstToWrite === "A" ? 0 : 1].go();
    const won = await winner;
    held[firstToWrite === "A" ? 1 : 0].go();
    expect(await code(loser)).toBe("CONFLICT");
    kv.beforeSet = undefined;
    const f = (await loadPlan(planId, CTX())).facts.nodes.n1;
    const want = firstToWrite === "A" ? QID(1) : QID(2);
    expect(won.quoteId).toBe(want);
    expect(f.intents.map((i) => i.quoteId)).toEqual([want]);
    expect(f.intents.filter((i) => i === unresolvedIntent(f))).toHaveLength(1);
    expect(kv.store.has(planKeys.intent(planId, "n1", 2))).toBe(false);
  }
  it("slots are read 1, 2, … and reading stops at the first gap (like quote attempts) — writes never leave one", async () => {
    kv.enabled = true;
    const { loadPlan, planKeys, recordSigningIntent } = await lib();
    const planId = await ready();
    await putRaw(planKeys.intent(planId, "n1", 2), { planId, nodeId: "n1", quoteId: QID(1), attempt: 1, wallet: WALLET, intentAt: T0, buildDigest: D("a") });
    expect((await loadPlan(planId, CTX())).facts.nodes.n1.intents).toEqual([]);
    await recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX());
    expect(kv.sets.filter((x) => x.key.includes(":intent:")).map((x) => x.key)).toEqual([planKeys.intent(planId, "n1", 1)]);
  });
  it("forced interleaving, A writes first: both computed slot 1, A wins, B gets CONFLICT", async () => { await forcedRace("A"); });
  it("forced interleaving, B writes first: both computed slot 1, B wins, A gets CONFLICT", async () => { await forcedRace("B"); });

  describe.each([["KV", true], ["in-memory", false]])("%s", (_l, useKv) => {
    beforeEach(() => { kv.enabled = useKv as boolean; });

    it("two concurrent intents from the same snapshot compute the same slot; exactly one wins", async () => {
      const { recordSigningIntent, loadPlan } = await lib();
      const planId = await ready();
      const res = await Promise.allSettled([
        recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX()),
        recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("b") }, CTX()),
      ]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((res.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("CONFLICT");
      expect((await loadPlan(planId, CTX())).facts.nodes.n1.intents).toHaveLength(1);
    });
    it("the same intent repeated concurrently is idempotent — one fact, one slot", async () => {
      const { recordSigningIntent, loadPlan } = await lib();
      const planId = await ready();
      const [x, y] = await Promise.all([
        recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX()),
        recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX()),
      ]);
      expect(x).toEqual(y);
      expect((await loadPlan(planId, CTX())).facts.nodes.n1.intents).toHaveLength(1);
      // …and again later, still slot 1.
      expect(await recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX())).toEqual(x);
    });
    it("an unresolved intent refuses a new quote's intent; after its release the next intent takes slot 2", async () => {
      const { recordQuote, recordSigningIntent, recordRelease, loadPlan, planKeys } = await lib();
      const planId = await ready();
      await recordSigningIntent(planId, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX());
      await recordQuote(planId, "n1", quoteInput(2), CTX());
      expect(await code(recordSigningIntent(planId, "n1", { quoteId: QID(2), buildDigest: D("b") }, CTX()))).toBe("SIGNATURE_UNRESOLVED");
      await recordRelease(planId, "n1", { quoteId: QID(1), reason: "wallet_rejected" }, CTX());
      await recordSigningIntent(planId, "n1", { quoteId: QID(2), buildDigest: D("b") }, CTX());
      const f = (await loadPlan(planId, CTX())).facts.nodes.n1;
      expect(f.intents.map((i) => i.quoteId)).toEqual([QID(1), QID(2)]);
      expect((await getRaw(planKeys.intent(planId, "n1", 2))).quoteId).toBe(QID(2));
    });
    it("stored slots are checked on read: an unknown quote, a repeated quote, or an unresolved intent before a later one is CORRUPT", async () => {
      const { recordQuote, recordSigningIntent, loadPlan, planKeys } = await lib();
      const rec = (planId: string, quoteId: string, attempt: number) => ({ planId, nodeId: "n1", quoteId, attempt, wallet: WALLET, intentAt: T0, buildDigest: D("a") });
      // Unknown quote in slot 1.
      const p1 = await ready();
      await putRaw(planKeys.intent(p1, "n1", 1), rec(p1, QID(9), 1));
      expect(await code(loadPlan(p1, CTX()))).toBe("CORRUPT");
      // Two unresolved intents (slot 1 not released, slot 2 present).
      const p2 = (await create(sendDraft("intent_store_0002"))).core.planId;
      await (await lib()).approvePlan(p2, CTX());
      await recordQuote(p2, "n1", quoteInput(1), CTX());
      await recordSigningIntent(p2, "n1", { quoteId: QID(1), buildDigest: D("a") }, CTX());
      await recordQuote(p2, "n1", quoteInput(2), CTX());
      await putRaw(planKeys.intent(p2, "n1", 2), rec(p2, QID(2), 2));
      expect(await code(loadPlan(p2, CTX()))).toBe("CORRUPT");
      // The same quote in two slots.
      const p3 = (await create(sendDraft("intent_store_0003"))).core.planId;
      await (await lib()).approvePlan(p3, CTX());
      await recordQuote(p3, "n1", quoteInput(1), CTX());
      await putRaw(planKeys.intent(p3, "n1", 1), rec(p3, QID(1), 1));
      // Slot 1 is released, so only the repeated quote is wrong.
      await putRaw(planKeys.release(p3, "n1", QID(1)), { planId: p3, nodeId: "n1", quoteId: QID(1), wallet: WALLET, reason: "wallet_rejected", releasedAt: T0 });
      expect((await loadPlan(p3, CTX())).facts.nodes.n1.intents).toHaveLength(1);
      await putRaw(planKeys.intent(p3, "n1", 2), rec(p3, QID(1), 1));
      expect(await code(loadPlan(p3, CTX()))).toBe("CORRUPT");
    });
  });
});
