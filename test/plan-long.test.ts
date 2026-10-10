import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Action, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";
import { runPlanInApp } from "@/lib/plans-client/app";
import { approvePlan, createPlanFromText, getPlanWithReview, type PlanReviewDTO } from "@/lib/plans-client/api";
import { canStartRun, describeOutcome, planStatus } from "@/lib/plans-client/view";
import { classifyOutcome } from "@/lib/plans-client/outcomes";
import { analyzePlanRequest, planFoundText } from "@/lib/ask/planFastPath";
import { createPlanForTurn } from "@/lib/ask/planTurn";
import type { HttpFn, PlanViewDTO, RunnerWallet } from "@/lib/plans-client/runner";

/**
 * Long multi-action plans (100+ actions) — harness shared in spirit with
 * test/plan-multi-action.test.ts. Phase 2 — multi-action plans. One request with several actions becomes ONE
 * plan: one review, one approval, run by the EXISTING runner in the order the
 * user wrote, stopping at the first failure, never repeating a completed
 * action.
 *
 * Nothing here adds an execution path: the grammar (lib/plan-adapter) only
 * accepts more shapes, and the adapter makes each action depend on the one
 * before it. The Plan Service, store, runner, journal, lock and signing
 * intent are the existing ones, exercised through the real routes below.
 */

const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const TARGET = "0x00000000000000000000000000000000000000f1";
const BASE = "https://app.usepayai.xyz";
const CHAIN = 143;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
/** A distinct, valid, non-zero recipient per position. */
const addr = (i: number) => `0x${(0x1000 + i).toString(16).padStart(40, "0")}`;
const TOKENS = { monDecimals: 18, stable: { symbol: "USDC", decimals: 6 } };
const MON = (n: string) => (BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n).toString();

const chain = vi.hoisted(() => ({
  txs: new Map<string, { from: string; to: string; input: string; value: bigint }>(),
  reverted: new Set<string>(),
}));
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
      const tx = chain.txs.get(hash);
      if (!tx) throw new Error("not found");
      return { status: chain.reverted.has(hash) ? "reverted" : "success", from: tx.from, logs: [] };
    },
    getTransaction: async ({ hash }: { hash: string }) => chain.txs.get(hash),
  }),
}));
vi.mock("@/lib/sdk/policy", () => ({
  enforcePaymentPolicy: async () => ({ allowed: true, warnings: [], riskScore: 5, riskLevel: "low", compliance: "approved" }),
}));
vi.mock("@/lib/payees/resolve", () => ({
  resolveRecipientInput: async (input: string) => ({ ok: false, message: `"${input}" isn't resolvable in this test.` }),
}));

/** A transfer fixture that records the ORDER its steps are built in. */
const built: string[] = [];
let buildSeq = 0;
const SEQ: ProtocolAdapter = {
  protocolId: "multi-send", name: "multi-send (fixture)", chainId: CHAIN, allowedTargets: [TARGET],
  actions: [{
    version: "1.0.0", name: "transfer", description: "fixture", protocolId: "multi-send", chainId: CHAIN, allowedTargets: [TARGET],
    actionId: "transfer",
    inputSchema: {
      recipient: { type: "address", required: true, description: "to" },
      token: { type: "token", required: false, description: "token" },
      amount: { type: "units", required: true, description: "amount" },
    },
    outputs: { amount: { type: "units", description: "sent", denominatedIn: { input: "token" } } },
    async quote(inputs: Record<string, string>) { return { summary: `send ${inputs.amount}`, details: { Amount: inputs.amount }, quotedAt: Date.now(), terms: { amount: inputs.amount } }; },
    async build(inputs: Record<string, string>) {
      built.push(inputs.amount);
      return [{ kind: "action", label: "Send", tx: { to: TARGET, data: `0x5e${(++buildSeq).toString(16).padStart(8, "0")}`, value: "0" } }] as UnsignedActionStep[];
    },
    async confirmedOutputs() {
      return { outputs: { amount: { verified: true as const, type: "units" as const, value: "1", token: USDC } }, denominations: { token: USDC } };
    },
    async parseResult() { return {}; },
    async outflows() { return []; },
  } as unknown as Action],
};

/* ── Browser stand-ins (as in plan-app-integration) ──────────────────────── */

function memoryStorage() {
  const m = new Map<string, string>();
  return { map: m, getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
}
function memoryLocks() {
  const held = new Set<string>();
  return {
    async request(name: string, _o: unknown, cb: (lock: unknown) => Promise<unknown>) {
      if (held.has(name)) return cb(null);
      held.add(name);
      try { return await cb({ name }); } finally { held.delete(name); }
    },
  };
}
function memoryWallet() {
  const w = {
    sends: 0,
    /** The Nth send (1-based) whose transaction reverts on-chain. */
    revertSend: 0,
    gate: null as Promise<void> | null,
    state: {
      address: WALLET, chainId: CHAIN, isWrongNetwork: false,
      async sendTransaction(tx: { to: string; data?: string; value?: string }) {
        w.sends++;
        vi.setSystemTime(Date.now() + 10_000); // a person reviews and signs each action
        if (w.gate) await w.gate;
        const hash = H(0xb00000 + w.sends + buildSeq * 0x100);
        chain.txs.set(hash, { from: WALLET, to: tx.to, input: tx.data ?? "0x", value: BigInt(tx.value ?? "0") });
        if (w.sends === w.revertSend) chain.reverted.add(hash);
        return hash;
      },
      async waitForReceipt() { return { status: "success" }; },
    } as RunnerWallet,
  };
  return w;
}

async function routes() {
  const { encodeWalletGrant, WALLET_GRANT_COOKIE } = await import("@/lib/auth/walletGrant");
  const cookie = `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(WALLET, Date.now() + 3_600_000)}`;
  const log: string[] = [];
  const http: HttpFn = async (url, init) => {
    const u = new URL(url, BASE);
    let op: string = init.method ?? "GET";
    if (typeof init.body === "string") {
      try { const b = JSON.parse(init.body) as { op?: unknown }; if (typeof b.op === "string") op = b.op; } catch { /* not JSON */ }
    }
    log.push(u.pathname.startsWith("/api/plans/") ? `plan:${op}` : u.pathname === "/api/plans" ? `plans:${op}` : u.pathname);
    const req = new NextRequest(u, { method: init.method, headers: { ...(init.headers as Record<string, string>), cookie, "x-real-ip": "203.0.113.7" }, ...(init.body ? { body: init.body as string } : {}) });
    let res: Response;
    if (u.pathname === "/api/auth/wallet-grant") res = await (await import("@/app/api/auth/wallet-grant/route")).GET(req);
    else if (u.pathname === "/api/ask/action/build") res = await (await import("@/app/api/ask/action/build/route")).POST(req);
    else if (u.pathname === "/api/ask/action/confirm") res = await (await import("@/app/api/ask/action/confirm/route")).POST(req);
    else if (u.pathname.startsWith("/api/plans/")) {
      const planId = decodeURIComponent(u.pathname.slice("/api/plans/".length));
      const mod = await import("@/app/api/plans/[planId]/route");
      const ctx = { params: Promise.resolve({ planId }) };
      res = init.method === "GET" ? await mod.GET(req, ctx) : await mod.POST(req, ctx);
    } else if (u.pathname === "/api/plans") {
      const mod = await import("@/app/api/plans/route");
      res = init.method === "GET" ? await mod.GET(req) : await mod.POST(req);
    } else throw new Error(`unrouted ${u.pathname}`);
    return { status: res.status, text: () => res.text() };
  };
  /** The same calls through the app's own API client (lib/plans-client/api). */
  const f = (url: string, init: RequestInit) => http(url, init as Parameters<HttpFn>[1]);
  return { http, f, log };
}

/** An approved plan of `amounts.length` fixture transfers, each depending on
 *  the one before it — exactly the shape the adapter now drafts. */
async function approvedChain(http: HttpFn, amounts: string[], seq = 1): Promise<string> {
  const recipients = amounts.map((_, i) => addr(i));
  const draft = {
    id: `intent_multi_${String(seq).padStart(4, "0")}`, version: 1, chainId: CHAIN, wallet: WALLET, status: "draft",
    source: { text: amounts.map((a, i) => `send ${a} to ${recipients[i]}`).join(" and "), adapter: "deterministic", adapterVersion: "1" },
    nodes: amounts.map((amount, i) => ({
      nodeId: `n${i + 1}`, ref: { protocolId: "multi-send", actionId: "transfer", version: "1.0.0" }, dependsOn: i > 0 ? [`n${i}`] : [],
      inputs: { recipient: { kind: "recipient", display: recipients[i], source: "address", address: recipients[i] }, token: { kind: "literal", value: USDC }, amount: { kind: "literal", value: amount } },
      validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
    })),
  };
  const created = await http(`${BASE}/api/plans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft }), credentials: "same-origin", cache: "no-store" });
  expect(created.status).toBe(200);
  const planId = JSON.parse(await created.text()).plan.planId as string;
  await (await import("@/lib/plan/store")).approvePlan(planId, { sessionWallet: WALLET, activeChainId: CHAIN });
  return planId;
}

const clock = { now: () => Date.now(), async sleep(ms: number) { vi.setSystemTime(Date.now() + ms); } };
function run(planId: string, w: ReturnType<typeof memoryWallet>, r: { http: HttpFn }, extra: Partial<Parameters<typeof runPlanInApp>[0]> = {}) {
  return runPlanInApp({ planId, wallet: () => w.state, chainId: CHAIN, http: r.http, baseUrl: BASE, clock, storage: extra.storage ?? memoryStorage(), locks: extra.locks ?? memoryLocks(), ...extra });
}
async function view(planId: string, r: { f: (u: string, i: RequestInit) => Promise<{ status: number; text(): Promise<string> }> }) {
  const g = await getPlanWithReview(planId, r.f);
  return g.body as { plan: PlanViewDTO; review: PlanReviewDTO };
}

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED", "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR", "PAYAI_TRADE_EXECUTOR_ENABLED", "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2", "PAYAI_TRADE_EXECUTOR_V2_ENABLED"] as const;
let saved: Record<string, string | undefined>;
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
  chain.txs.clear();
  chain.reverted.clear();
  built.length = 0;
  const g = globalThis as unknown as { __veripayIdem?: Map<string, unknown>; __veripayRL?: Map<string, unknown> };
  g.__veripayIdem?.clear();
  g.__veripayRL?.clear();
  (await import("@/lib/plan/store")).__resetPlanStoreForTests();
  (await import("@/lib/sdk/settlement")).__resetOutputRecordsForTests();
  const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
  registerProtocol(SEQ);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
});

/* ══ Long plans: the 4-action limit is gone; resource bounds remain ═══════ */

// 100+-action runs go through every real route for every action.
vi.setConfig({ testTimeout: 60_000 });

const transfers = (n: number, sep = ", ") => Array.from({ length: n }, (_, i) => `send ${i + 1} USDC to ${addr(i)}`).join(sep);
const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;

describe("parsing long requests", () => {
  const parse = async (text: string) => (await import("@/lib/plan-adapter/grammar")).parseIntent(text, TOKENS);

  it.each([1, 4, 5, 10, 50, 100, 101, 150, 500])("%i actions: every one parsed, in order, none dropped or duplicated", async (n) => {
    const text = transfers(n);
    const t0 = performance.now();
    const r = await parse(text);
    const took = ms(t0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps).toHaveLength(n);
    r.steps.forEach((s, i) => {
      expect(s.kind).toBe("transfer");
      if (s.kind !== "transfer") return;
      expect(s.recipient.display).toBe(addr(i));
      expect(s.amount).toEqual({ kind: "units", units: String((i + 1) * 1_000_000) });
    });
    expect(new Set(r.steps.map((s) => s.kind === "transfer" && s.recipient.display)).size).toBe(n);
    console.info(`[perf] parse ${n} actions (${text.length} chars): ${took} ms`);
    expect(took).toBeLessThan(1_000);
  });

  it("the verb-carried form and mixed connectors also scale (\"…, 2 USDC to b and 3 USDC to c, then …\")", async () => {
    const parts = Array.from({ length: 120 }, (_, i) => (i === 0 ? `send 1 USDC to ${addr(0)}` : `${i + 1} USDC to ${addr(i)}`));
    const text = parts.map((p, i) => (i === 0 ? p : `${i % 3 === 0 ? " and " : i % 3 === 1 ? ", " : ", then "}${p}`)).join("");
    const r = await parse(text);
    expect(r.ok && r.steps.length).toBe(120);
  });

  it("13. one bad action (no. 87 of 120) refuses the WHOLE request — and says which one", async () => {
    const parts = Array.from({ length: 120 }, (_, i) => `send ${i + 1} USDC to ${addr(i)}`);
    parts[86] = `send 87 DOGE to ${addr(86)}`;
    const r = await parse(parts.join(", "));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("UNSUPPORTED_TOKEN");
      expect(r.message).toMatch(/^Action 87 of 120: /);
    }
    parts[86] = `send 87 USDC to 0x${"0".repeat(40)}`;
    const z = await parse(parts.join(", "));
    expect(!z.ok && z.message).toMatch(/^Action 87 of 120: Give the recipient/);
  });

  it("the resource ceiling: 500 actions accepted, 501 refused (TOO_MANY_ACTIONS); an enormous payload is TOO_LONG before any work", async () => {
    const { MAX_ACTIONS, MAX_REQUEST_LENGTH } = await import("@/lib/plan-adapter/grammar");
    expect(MAX_ACTIONS).toBe(500);
    const ok = await parse(transfers(500));
    expect(ok.ok).toBe(true);
    const many = await parse(Array.from({ length: 501 }, (_, i) => `send 1 MON to a${i}`).join(", "));
    expect(!many.ok && many.code).toBe("TOO_MANY_ACTIONS");
    const t0 = performance.now();
    const huge = await parse("send 1 MON to alice.nad, ".repeat(200_000));
    expect(!huge.ok && huge.code).toBe("TOO_LONG");
    expect(ms(t0)).toBeLessThan(50); // refused on length alone
    expect(MAX_REQUEST_LENGTH).toBe(40_000);
  });
});

describe("draft + validation of long chains", () => {
  const draftOf = async (text: string) => {
    const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
    const r = draftIntentGraph(text, { intentId: "intent_" + "d".repeat(24), wallet: WALLET, chainId: CHAIN });
    if (!r.ok) throw new Error(r.code);
    return r.draft;
  };

  it.each([10, 50, 100, 150, 500])("14 / 15. %i-action dependency chain: each depends on the one before; validator order = written order", async (n) => {
    const t0 = performance.now();
    const draft = await draftOf(transfers(n));
    const tDraft = ms(t0);
    draft.nodes.forEach((node, i) => expect(node.dependsOn).toEqual(i === 0 ? [] : [`n${i}`]));
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const { planIntent } = await import("@/lib/plan/planner");
    const t1 = performance.now();
    const v = validateIntentGraph(draft, { sessionWallet: WALLET, activeChainId: CHAIN });
    const tValidate = ms(t1);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.order).toEqual(Array.from({ length: n }, (_, i) => `n${i + 1}`));
    const t2 = performance.now();
    const plan = planIntent(v.value, { sessionWallet: WALLET });
    const tPlan = ms(t2);
    expect(plan.steps.map((s) => s.nodeId)).toEqual(v.value.order);
    console.info(`[perf] ${n} actions — draft ${tDraft} ms, validate ${tValidate} ms, plan ${tPlan} ms, serialized draft ${JSON.stringify(draft).length} bytes`);
    expect(tValidate).toBeLessThan(2_000);
  });

  it("a cycle anywhere in a long chain is still found (iteratively — no recursion depth)", async () => {
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const draft = await draftOf(transfers(300));
    (draft.nodes[0] as { dependsOn: string[] }).dependsOn = ["n300"];
    const v = validateIntentGraph(draft, { sessionWallet: WALLET, activeChainId: CHAIN });
    expect(!v.ok && v.error.code).toBe("CYCLE");
  });
});

describe("one plan, one approval, for 100+ actions (real Plan API)", () => {
  it.each([120, 500])("10 / 11. a %i-action request is ONE plan; its review lists every action; one approval covers them all", async (n) => {
    const r = await routes();
    const t0 = performance.now();
    const c = await createPlanFromText(transfers(n), r.f);
    const tCreate = ms(t0);
    expect(c.status).toBe(200);
    const { plan, review } = c.body as { plan: PlanViewDTO; review: PlanReviewDTO };
    expect(review.steps).toHaveLength(n);
    expect(review.steps.map((s) => s.order)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(review.steps.every((s) => s.action === "transfer")).toBe(true);
    expect(review.reviewable).toBe(true);
    expect(r.log.filter((l) => l === "plans:POST")).toHaveLength(1);
    const a = await approvePlan(plan.planId, r.f);
    expect(a.status).toBe(200);
    const t1 = performance.now();
    const after = await view(plan.planId, r);
    const tLoad = ms(t1);
    expect(after.plan.approved).toBe(true);
    expect(after.plan.nodes).toHaveLength(n);
    expect(after.review.steps.map((s) => s.nodeId)).toEqual(review.steps.map((s) => s.nodeId)); // the same actions, after approval
    const { MAX_PLAN_RECORD_BYTES } = await import("@/lib/plan/store");
    const size = JSON.stringify(c.body).length;
    console.info(`[perf] ${n}-action plan: create ${tCreate} ms, load ${tLoad} ms, create response ${size} bytes (record cap ${MAX_PLAN_RECORD_BYTES})`);
  });
});

describe("the existing runner over long plans", () => {
  it("120 actions: every one built and signed exactly once, strictly in order (the runner's guard scales with the plan)", async () => {
    const r = await routes();
    const amounts = Array.from({ length: 120 }, (_, i) => String(i + 1));
    const planId = await approvedChain(r.http, amounts);
    const w = memoryWallet();
    const t0 = performance.now();
    const res = await run(planId, w, r);
    console.info(`[perf] runner: 120 actions in ${ms(t0)} ms (in-memory store; every action reviewed, signed, confirmed)`);
    expect(res.outcome.kind).toBe("completed");
    expect(built).toEqual(amounts);
    expect(w.sends).toBe(120);
    const v = await view(planId, r);
    expect(v.plan.state).toBe("completed");
    expect(v.plan.nodes.every((n) => n.state === "confirmed")).toBe(true);
  });

  it.each([50, 99])("16 / 17. failure at action %i of 120: before it confirmed, it failed, after it never started", async (k) => {
    const r = await routes();
    const planId = await approvedChain(r.http, Array.from({ length: 120 }, (_, i) => String(i + 1)));
    const w = memoryWallet();
    w.revertSend = k;
    const res = await run(planId, w, r);
    expect(res.outcome.kind).toBe("reverted");
    expect(res.outcome.nodeId).toBe(`n${k}`);
    expect(built).toHaveLength(k);
    const states = (await view(planId, r)).plan.nodes.map((n) => n.state);
    expect(states.slice(0, k - 1).every((s) => s === "confirmed")).toBe(true);
    expect(states[k - 1]).toBe("reverted");
    expect(states.slice(k).every((s) => s === "skipped")).toBe(true);
    const cls = classifyOutcome(res.outcome);
    expect([cls.retry, cls.action]).toEqual(["DO_NOT_RETRY", "check_wallet_activity"]);
    expect(describeOutcome(res).canResume).toBe(false);
  });

  it("18 / 19. after a failure at action 74, running again and a refresh never resend actions 1–73", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, Array.from({ length: 120 }, (_, i) => String(i + 1)));
    const w = memoryWallet();
    w.revertSend = 74;
    const storage = memoryStorage();
    await run(planId, w, r, { storage });
    const sends = w.sends;
    const again = await run(planId, w, r, { storage });
    const refreshed = await run(planId, w, r, { storage: memoryStorage(), locks: memoryLocks() });
    expect([again.outcome.kind, refreshed.outcome.kind]).toEqual(["reverted", "reverted"]);
    expect(w.sends).toBe(sends);
    expect(built).toHaveLength(74);
  });

  it("an interrupted 120-action run resumes where it stopped — never at action 1", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, Array.from({ length: 120 }, (_, i) => String(i + 1)));
    const w = memoryWallet();
    const ac = new AbortController();
    const realSend = w.state.sendTransaction;
    w.state.sendTransaction = async (tx) => {
      const h = await realSend(tx);
      if (w.sends === 60) ac.abort(); // stop right after action 60 is sent
      return h;
    };
    const first = await run(planId, w, r, { signal: ac.signal });
    expect(first.outcome.kind).toBe("aborted");
    const mid = (await view(planId, r)).plan.nodes.map((n) => n.state);
    expect(mid.filter((s) => s === "confirmed").length).toBeGreaterThanOrEqual(59);
    const second = await run(planId, w, r, { storage: memoryStorage(), locks: memoryLocks() });
    expect(second.outcome.kind).toBe("completed");
    expect(w.sends).toBe(120);
    expect(built).toEqual(Array.from({ length: 120 }, (_, i) => String(i + 1)));
  });

  it("20. a second tab can't run a long plan while the first holds the lock", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, Array.from({ length: 101 }, (_, i) => String(i + 1)));
    const w = memoryWallet();
    let open!: () => void;
    w.gate = new Promise<void>((res) => { open = res; });
    const locks = memoryLocks();
    const first = run(planId, w, r, { locks });
    await vi.waitFor(() => expect(w.sends).toBe(1));
    expect((await run(planId, w, r, { locks })).outcome.kind).toBe("already_running");
    open();
    expect((await first).outcome.kind).toBe("completed");
    expect(w.sends).toBe(101);
  });

  it("21. plan expiry stays safe: nothing is sent once the plan has expired, even mid-way", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, Array.from({ length: 101 }, (_, i) => String(i + 1)));
    const w = memoryWallet();
    const ac = new AbortController();
    const realSend = w.state.sendTransaction;
    w.state.sendTransaction = async (tx) => {
      const h = await realSend(tx);
      if (w.sends === 30) ac.abort();
      return h;
    };
    await run(planId, w, r, { signal: ac.signal });
    const sends = w.sends;
    const { PLAN_TTL_SECONDS } = await import("@/lib/plan/store");
    vi.setSystemTime(Date.now() + PLAN_TTL_SECONDS * 1000 + 1_000);
    const fresh = await routes(); // a current wallet grant: what's refused is the PLAN
    const late = await run(planId, w, fresh, { storage: memoryStorage(), locks: memoryLocks() });
    expect(["expired", "not_found"]).toContain(late.outcome.kind);
    expect(w.sends).toBe(sends);
  });
});

describe("the validated-plan memo never serves a stale plan", () => {
  it("a registry change invalidates it: a cached plan whose action is gone no longer loads", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, Array.from({ length: 10 }, (_, i) => String(i + 1)));
    expect((await getPlanWithReview(planId, r.f)).status).toBe(200); // validated and memoized
    expect((await getPlanWithReview(planId, r.f)).status).toBe(200); // served from the memo
    const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
    __resetRegistryForTests(); // the fixture action is no longer registered
    const after = await getPlanWithReview(planId, r.f);
    expect(after.status).not.toBe(200);
  });
});
