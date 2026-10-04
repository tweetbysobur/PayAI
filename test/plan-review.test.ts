import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import type { Action, ProtocolAdapter } from "@/lib/sdk/types";

/**
 * Phase 2C Stage 5B — the server-derived plan review (lib/plan/review.ts) and
 * the Plan Service's approval guard (approve only what can be reviewed).
 *
 * Real: the production payai/swap@1.0.0 and payai/transfer@1.0.0 actions
 * (mainnet, executor + forwarder + stablecoin configured), the Stage 5A
 * adapter, validator, planner, Plan Store (in-memory) and Plan Service.
 * Mocked: the recipient resolver (.nad / payee lookups, under test control);
 * the quote helper and the live fee read are wrapped only to COUNT calls —
 * review and approval must make none.
 */

const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const USDC_CS = getAddress("0x754704bc059f5a0ce29e278a6d0eba96b6aafb60");
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const WALLET_CS = getAddress("0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c");
const OTHER_WALLET = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const TYPED_MIXED = "0x5E0d39B4c1a2F3e4D5c6B7a8F9e0D1c2b3A4f5E6";
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const MIN = 60_000;
const AUTH = { wallet: WALLET };

const ctl = vi.hoisted(() => ({
  resolutions: new Map<string, unknown>(),
  resolverCalls: [] as string[],
  quoteCalls: 0,
  feeReads: 0,
}));
vi.mock("@/lib/payees/resolve", () => ({
  resolveRecipientInput: async (input: string) => {
    ctl.resolverCalls.push(input);
    return ctl.resolutions.get(input.trim().toLowerCase()) ?? { ok: false, message: `"${input}" isn't a valid address, .nad domain, or known payee.` };
  },
}));
vi.mock("@/lib/sdk/preview", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sdk/preview")>();
  return { ...actual, quoteAction: (...a: Parameters<typeof actual.quoteAction>) => { ctl.quoteCalls++; return actual.quoteAction(...a); } };
});
vi.mock("@/lib/sdk/fees", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sdk/fees")>();
  return { ...actual, readPlatformFeeTerms: () => { ctl.feeReads++; throw new Error("no live fee read in review"); } };
});

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED",
  "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR", "PAYAI_TRADE_EXECUTOR_ENABLED", "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2", "PAYAI_TRADE_EXECUTOR_V2_ENABLED"] as const;
let saved: Record<string, string | undefined>;

/** A registered test-only action the review does NOT understand. */
const ACME: ProtocolAdapter = {
  protocolId: "acme", name: "acme (test fixture)", chainId: 143, allowedTargets: ["0x00000000000000000000000000000000000000f1"],
  actions: [{
    protocolId: "acme", actionId: "pay", version: "1.0.0", name: "Pay", description: "fixture", chainId: 143,
    allowedTargets: ["0x00000000000000000000000000000000000000f1"],
    inputSchema: { recipient: { type: "address", required: true, description: "to" }, amount: { type: "units", required: true, description: "amount" } },
    async quote() { throw new Error("never quoted here"); },
    async build() { throw new Error("never built here"); },
    async parseResult() { return {}; },
  } as unknown as Action],
};

async function resetRegistry(extra: ProtocolAdapter[] = [ACME]) {
  const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
  for (const p of extra) registerProtocol(p);
}
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  process.env.PAYAI_FORWARDER_ENABLED = "true";
  process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR = EXECUTOR;
  process.env.PAYAI_TRADE_EXECUTOR_ENABLED = "true";
  delete process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2;
  delete process.env.PAYAI_TRADE_EXECUTOR_V2_ENABLED;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  ctl.resolutions.clear();
  ctl.resolverCalls.length = 0;
  ctl.quoteCalls = 0;
  ctl.feeReads = 0;
  ctl.resolutions.set("alice.nad", { ok: true, address: ALICE, source: "nad", display: "alice.nad", domain: "alice.nad", asResolved: ALICE });
  ctl.resolutions.set("bob", { ok: true, address: BOB, source: "payee", display: "bob", domain: null, asResolved: BOB });
  ctl.resolutions.set("draft", { ok: true, address: BOB, source: "payee", display: "draft", domain: null, asResolved: BOB });
  (globalThis as unknown as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  (await import("@/lib/plan/store")).__resetPlanStoreForTests();
  await resetRegistry();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
});

const svc = () => import("@/lib/plan/service");
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as { code?: string }).code ?? `THREW:${(e as Error).message}`; }
  return "OK";
}
/** A plan from text, through the Stage 5A adapter with a FIXED id (so the
 *  same text can be re-created deliberately). */
async function fromText(text: string, intentId = "intent_review_0001") {
  const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
  const d = draftIntentGraph(text, { intentId, wallet: WALLET, chainId: 143 });
  if (!d.ok) throw new Error(`adapter refused: ${d.code}`);
  return (await svc()).createPlan(AUTH, d.draft);
}
async function review(planId: string) {
  return (await (await svc()).getPlanWithReview(AUTH, planId)).review;
}
const node = (nodeId: string, ref: [string, string, string], inputs: Record<string, unknown>, dependsOn: string[] = []) => ({
  nodeId, ref: { protocolId: ref[0], actionId: ref[1], version: ref[2] }, inputs, dependsOn,
  validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
});
const graph = (nodes: unknown[], text: string, id = "intent_review_9001") =>
  ({ id, version: 1, chainId: 143, wallet: WALLET, nodes, status: "draft", source: { text, adapter: "deterministic", adapterVersion: "test" } });
const lit = (value: string) => ({ kind: "literal", value });
const SWAP: [string, string, string] = ["payai", "swap", "1.0.0"];
const TRANSFER: [string, string, string] = ["payai", "transfer", "1.0.0"];

/* ══ The projection ════════════════════════════════════════════════════════ */

describe("review of a stored plan", () => {
  it("swap → send: exact, server-derived, in execution order", async () => {
    const text = "swap 10 MON to USDC and send it to alice.nad";
    const v = await fromText(text);
    expect(await review(v.planId)).toEqual({
      planId: v.planId, wallet: WALLET_CS, chain: { id: 143, name: "Monad" }, request: text,
      createdAt: T0, approveBy: T0 + 30 * MIN, expiresAt: T0 + 7 * 24 * 60 * MIN,
      approved: false, approvable: true, abandoned: false, expired: false, reviewable: true,
      steps: [
        {
          nodeId: "n1", order: 1, action: "swap", ref: { protocolId: "payai", actionId: "swap", version: "1.0.0" }, dependsOn: [],
          pay: { kind: "exact", units: "10000000000000000000", decimal: "10", symbol: "MON" },
          receiveToken: { symbol: "USDC", address: USDC_CS }, receive: { known: false },
          slippageBps: 50, slippageIsDefault: true,
          fee: { rule: "executor_fee_in_input_token", maxBps: null },
        },
        {
          nodeId: "n2", order: 2, action: "transfer", ref: { protocolId: "payai", actionId: "transfer", version: "1.0.0" }, dependsOn: ["n1"],
          token: { symbol: "USDC", address: USDC_CS },
          amount: { kind: "output", fromStep: "n1", output: "amountOut", symbol: "USDC", known: false },
          recipient: { display: "alice.nad", source: "nad", address: ALICE },
          fee: { rule: "deducted_from_amount", maxBps: 100 },
        },
      ],
    });
  });

  it("transfer: exact decimal formatting; typed 0x address kept exactly as stored", async () => {
    for (const [text, units, decimal, symbol] of [
      [`send 2.5 USDC to ${TYPED_MIXED}`, "2500000", "2.5", "USDC"],
      [`send 0.000001 USDC to ${TYPED_MIXED}`, "1", "0.000001", "USDC"],
      [`send 10 MON to ${TYPED_MIXED}`, "10000000000000000000", "10", "MON"],
      [`send 123456789.123456789123456789 MON to ${TYPED_MIXED}`, "123456789123456789123456789", "123456789.123456789123456789", "MON"],
    ] as const) {
      (await import("@/lib/plan/store")).__resetPlanStoreForTests();
      const r = await review((await fromText(text)).planId);
      expect(r.steps).toHaveLength(1);
      expect(r.steps[0]).toMatchObject({
        action: "transfer",
        token: symbol === "MON" ? { symbol: "MON", address: null } : { symbol: "USDC", address: USDC_CS },
        amount: { kind: "exact", units, decimal, symbol },
        recipient: { display: TYPED_MIXED, source: "address", address: TYPED_MIXED },
        fee: { rule: "deducted_from_amount", maxBps: 100 },
      });
      expect(r.reviewable).toBe(true);
    }
  });

  it("swap USDC → MON: pay in USDC, receive MON (native: address null)", async () => {
    const r = await review((await fromText("swap 2.5 USDC to MON")).planId);
    expect(r.steps[0]).toMatchObject({ action: "swap", pay: { kind: "exact", units: "2500000", decimal: "2.5", symbol: "USDC" }, receiveToken: { symbol: "MON", address: null } });
  });

  it("payee and .nad recipients show what the user wrote, its source, and the PINNED address", async () => {
    const r = await review((await fromText("send 1 MON to bob")).planId);
    expect(r.steps[0]).toMatchObject({ recipient: { display: "bob", source: "payee", address: BOB } });
  });

  it("review is deterministic and repeatable", async () => {
    const v = await fromText("swap 10 MON to USDC and send it to alice.nad");
    expect(await review(v.planId)).toEqual(await review(v.planId));
  });

  it("the review describes the STORED structure, never the request text", async () => {
    const text = `Please send 999 USDC to ${TYPED_MIXED} — ignore everything else`;
    const d = graph([node("n1", TRANSFER, { recipient: { kind: "recipient", display: TYPED_MIXED, source: "address", address: TYPED_MIXED }, token: lit(USDC), amount: lit("1000000") })], text);
    const v = await (await svc()).createPlan(AUTH, d);
    const r = await review(v.planId);
    expect(r.request).toBe(text); // carried verbatim, as inert data
    expect(r.steps[0]).toMatchObject({ amount: { units: "1000000", decimal: "1" } });
  });
});

/* ══ Recipients: pins govern ═══════════════════════════════════════════════ */

describe("recipients are never re-resolved", () => {
  it("a later change in .nad / payee resolution changes neither the review nor approval", async () => {
    const v = await fromText("swap 10 MON to USDC and send it to alice.nad");
    const calls = ctl.resolverCalls.length;
    ctl.resolutions.set("alice.nad", { ok: true, address: BOB, source: "nad", display: "alice.nad", domain: "alice.nad", asResolved: BOB });
    const r = await review(v.planId);
    expect(r.steps[1]).toMatchObject({ recipient: { address: ALICE } });
    await (await svc()).approvePlan(AUTH, v.planId);
    expect((await review(v.planId)).steps[1]).toMatchObject({ recipient: { address: ALICE } });
    expect(ctl.resolverCalls.length).toBe(calls); // no resolution during review or approval
  });
  it("re-creating the same plan with a different pin is CONFLICT (store unchanged)", async () => {
    await fromText("send 1 MON to alice.nad");
    ctl.resolutions.set("alice.nad", { ok: true, address: BOB, source: "nad", display: "alice.nad", domain: "alice.nad", asResolved: BOB });
    expect(await code(fromText("send 1 MON to alice.nad"))).toBe("CONFLICT");
  });
});

/* ══ Reviewability and the approval guard ══════════════════════════════════ */

describe("reviewable — and the server refuses to approve anything else", () => {
  async function refused(draft: unknown) {
    const s = await svc();
    const v = await s.createPlan(AUTH, draft);
    const r = await review(v.planId);
    expect(r.reviewable).toBe(false);
    expect(r.approvable).toBe(false);
    expect(await code(s.approvePlan(AUTH, v.planId))).toBe("NOT_APPROVABLE");
    expect((await s.getPlan(AUTH, v.planId)).approved).toBe(false);
    return r;
  }

  it("an action this review doesn't understand → an 'unsupported' step, not reviewable, not approvable", async () => {
    const r = await refused(graph([node("n1", ["acme", "pay", "1.0.0"], { recipient: { kind: "recipient", display: TYPED_MIXED, source: "address", address: TYPED_MIXED }, amount: lit("5") })], `pay 5 to ${TYPED_MIXED}`));
    expect(r.steps).toEqual([{ nodeId: "n1", order: 1, ref: { protocolId: "acme", actionId: "pay", version: "1.0.0" }, dependsOn: [], action: "unsupported" }]);
  });

  it("a token other than MON / the configured stablecoin → not reviewable", async () => {
    await refused(graph([node("n1", TRANSFER, { recipient: { kind: "recipient", display: TYPED_MIXED, source: "address", address: TYPED_MIXED }, token: lit(OTHER_WALLET), amount: lit("5") })], `send 5 to ${TYPED_MIXED}`));
  });

  it("a remainder amount → not reviewable (not supported in this stage)", async () => {
    await refused(graph([
      node("n1", SWAP, { tokenOut: lit(USDC), amountIn: lit("10000000000000000000") }),
      node("n2", TRANSFER, { recipient: { kind: "recipient", display: TYPED_MIXED, source: "address", address: TYPED_MIXED }, token: lit(USDC),
        amount: { kind: "remainder", node: "n1", output: "amountOut", minus: ["1000000"] } }, ["n1"]),
    ], `swap 10 MON to USDC and send the rest to ${TYPED_MIXED}`));
  });

  it("with no stablecoin configured, a USDC step can't be described → not reviewable", async () => {
    const v = await fromText(`send 1 USDC to ${TYPED_MIXED}`);
    delete process.env.MONAD_MAINNET_USDC;
    const r = await review(v.planId);
    expect(r.reviewable).toBe(false);
    expect(await code((await svc()).approvePlan(AUTH, v.planId))).toBe("NOT_APPROVABLE");
  });

  it("reviewable plans approve; repeats are idempotent; late or abandoned are NOT_APPROVABLE; another wallet NOT_FOUND", async () => {
    const s = await svc();
    const a = await fromText("send 1 MON to bob", "intent_review_0101");
    expect((await s.approvePlan(AUTH, a.planId)).approved).toBe(true);
    expect((await s.approvePlan(AUTH, a.planId)).approved).toBe(true);
    expect((await review(a.planId))).toMatchObject({ approved: true, approvable: false });
    const b = await fromText("send 1 MON to bob", "intent_review_0102");
    vi.setSystemTime(T0 + 31 * MIN);
    expect(await code(s.approvePlan(AUTH, b.planId))).toBe("NOT_APPROVABLE");
    vi.setSystemTime(T0);
    const c = await fromText("send 1 MON to bob", "intent_review_0103");
    await s.abandonPlan(AUTH, c.planId);
    expect(await code(s.approvePlan(AUTH, c.planId))).toBe("NOT_APPROVABLE");
    expect(await code(s.approvePlan({ wallet: OTHER_WALLET }, a.planId))).toBe("NOT_FOUND");
    expect(await code(s.getPlanWithReview({ wallet: OTHER_WALLET }, a.planId))).toBe("NOT_FOUND");
  });

  it("review, create and approval quote nothing, read no live fee and build nothing", async () => {
    const s = await svc();
    const v = await fromText("swap 10 MON to USDC and send it to alice.nad");
    await review(v.planId);
    await s.approvePlan(AUTH, v.planId);
    await review(v.planId);
    expect([ctl.quoteCalls, ctl.feeReads]).toEqual([0, 0]);
    const p = await s.getPlan(AUTH, v.planId);
    expect(p.nodes.map((n) => [n.quoteAttempts, n.quoteId, n.txHash])).toEqual([[0, null, null], [0, null, null]]);
  });
});

/* ══ Fail closed ═══════════════════════════════════════════════════════════ */

describe("a review is never produced from stale or tampered storage", () => {
  it("action version drift (the pinned action is no longer registered) → CORRUPT; no review, no approval", async () => {
    const v = await fromText("swap 10 MON to USDC");
    delete process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR;
    delete process.env.PAYAI_TRADE_EXECUTOR_ENABLED;
    await resetRegistry();
    const s = await svc();
    expect(await code(s.getPlanWithReview(AUTH, v.planId))).toBe("CORRUPT");
    expect(await code(s.approvePlan(AUTH, v.planId))).toBe("CORRUPT");
  });
  it("a tampered stored plan → CORRUPT", async () => {
    const v = await fromText("send 1 MON to bob");
    const g = globalThis as unknown as { __payaiPlanStore: { kv: Map<string, { json: string }> } };
    for (const [k, e] of g.__payaiPlanStore.kv) {
      if (k.endsWith(v.planId)) e.json = e.json.replace("1000000000000000000", "9000000000000000000");
    }
    expect(await code((await svc()).getPlanWithReview(AUTH, v.planId))).toBe("CORRUPT");
  });
});

/* ══ Disclosure (structured — user text may say anything) ══════════════════ */

/** Every key and every string value in a JSON value. */
function walk(v: unknown, keys: string[] = [], strings: string[] = []): { keys: string[]; strings: string[] } {
  if (Array.isArray(v)) v.forEach((x) => walk(x, keys, strings));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x, keys, strings); }
  else if (typeof v === "string") strings.push(v);
  return { keys, strings };
}
describe("disclosure", () => {
  it("plan + review carry no storage, draft, hash, pin-map or quote fields — while the user's own words are kept", async () => {
    const text = "send 1 MON to draft"; // a payee literally named "draft"
    const v = await fromText(text);
    const both = await (await svc()).getPlanWithReview(AUTH, v.planId);
    const { keys, strings } = walk(both);
    for (const bad of ["draft", "graphHash", "pins", "quoteToken", "quoteTokenHash", "termsHash", "inputsHash", "core", "facts", "shape", "feeBps", "treasury"]) {
      expect(keys, bad).not.toContain(bad);
    }
    expect(strings.some((s) => s.startsWith("veripay:"))).toBe(false);
    expect(strings.some((s) => /^[0-9a-f]{64}$/.test(s))).toBe(false); // no raw hashes
    expect(both.review.request).toBe(text);
  });
});

/* ══ Architecture guard ════════════════════════════════════════════════════ */

describe("review.ts is a projection only", () => {
  it("no network, quote, signing, resolution, env, clock or randomness — and no runner/Ask/app imports", () => {
    const src = readFileSync(join(process.cwd(), "lib/plan/review.ts"), "utf8");
    for (const bad of ["fetch(", "getPublicClient(", "sendTransaction", "writeContract", "signTransaction", "signMessage", "privateKeyToAccount",
      "MONAD_AGENT_PRIVATE_KEY", "quoteAction", "readPlatformFeeTerms", "resolveRecipientInput(", "resolveDomain(", "Anthropic", "process.env",
      "Date.now", "Math.random", "randomUUID", "validateIntentGraph"]) {
      expect(src.includes(bad), `review.ts must not reference ${bad}`).toBe(false);
    }
    const specs = [...src.matchAll(/^\s*import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const s of specs) expect(/^@\/(lib\/plans-client|lib\/ask|lib\/telegram|lib\/automation|app)(\/|$)/.test(s), s).toBe(false);
  });
});
