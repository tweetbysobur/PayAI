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
 * Phase 2 — multi-action plans. One request with several actions becomes ONE
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
  const recipients = [A, B, C, A];
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

/* ══ 1. Parsing: every action, in order, nothing guessed ═══════════════════ */

describe("grammar: one request, several actions, in the order written", () => {
  const parse = async (text: string) => (await import("@/lib/plan-adapter/grammar")).parseIntent(text, TOKENS);
  const kinds = (r: Awaited<ReturnType<typeof parse>>) => (r.ok ? r.steps.map((s) => s.kind) : r.code);

  it("1. two transfers", async () => {
    const r = await parse(`send 0.2 MON to ${A} and send 0.3 MON to ${B}`);
    expect(r.ok && r.steps).toEqual([
      { kind: "transfer", token: "MON", amount: { kind: "units", units: MON("0.2") }, recipient: { source: "address", display: A } },
      { kind: "transfer", token: "MON", amount: { kind: "units", units: MON("0.3") }, recipient: { source: "address", display: B } },
    ]);
  });
  it("the verb carries over: \"send 0.2 MON to A and 0.3 MON to B\"", async () => {
    expect(kinds(await parse(`send 0.2 MON to ${A} and 0.3 MON to ${B}`))).toEqual(["transfer", "transfer"]);
  });
  it("2 / 7. three transfers to three recipients (commas, \"and\")", async () => {
    const r = await parse(`send 1 USDC to ${A}, 2 USDC to ${B} and 3 USDC to ${C}`);
    expect(r.ok && r.steps.map((s) => s.kind === "transfer" && [s.recipient.display, s.amount.kind === "units" && s.amount.units])).toEqual([[A, "1000000"], [B, "2000000"], [C, "3000000"]]);
  });
  it("3. transfer, then swap", async () => {
    expect(kinds(await parse(`send 0.2 MON to ${A}, then swap 10 USDC to MON`))).toEqual(["transfer", "swap"]);
  });
  it("4 / 6. swap, then transfer — order kept exactly as written", async () => {
    const r = await parse(`swap 10 USDC to MON then send 5 MON to ${A}`);
    expect(kinds(r)).toEqual(["swap", "transfer"]);
    expect(r.ok && r.steps[1]).toMatchObject({ kind: "transfer", token: "MON", amount: { kind: "units" } }); // 5 MON from the balance, not the swap's output
  });
  it("5. swap-then-send: the transfer is exactly what the swap returned", async () => {
    const r = await parse(`swap 10 MON to USDC and send it to ${A}`);
    expect(r.ok && r.steps[1]).toMatchObject({ kind: "transfer", token: "STABLE", amount: { kind: "output", step: 0, output: "amountOut" } });
  });
  it("the spec's example: two sends, then a swap", async () => {
    expect(kinds(await parse(`send 0.2 MON to ${A}, send 0.3 MON to ${B}, then swap 10 USDC to MON`))).toEqual(["transfer", "transfer", "swap"]);
  });
  it("multiple swaps", async () => {
    expect(kinds(await parse("swap 10 MON to USDC and swap 5 USDC to MON"))).toEqual(["swap", "swap"]);
  });
  it("a bound send binds the swap right before it, wherever it is in the request", async () => {
    const r = await parse(`send 1 MON to ${B}, then swap 10 MON to USDC and send the USDC to ${A}`);
    expect(r.ok && r.steps[2]).toMatchObject({ amount: { kind: "output", step: 1 } });
  });
  it.each([
    ["8. missing amount", `send MON to ${A} and 1 MON to ${B}`, "UNSUPPORTED_REQUEST"],
    ["8. a non-numeric amount", `send 1 MON to ${A} and send ten MON to ${B}`, "INVALID_AMOUNT"],
    ["9. missing token", `send 0.2 to ${A} and 1 MON to ${B}`, "UNSUPPORTED_REQUEST"],
    ["10. missing recipient", `send 1 MON to ${A} and send 2 MON`, "UNSUPPORTED_REQUEST"],
    ["11. invalid recipient (the zero address)", `send 1 MON to ${A} and 2 MON to 0x${"0".repeat(40)}`, "INVALID_RECIPIENT"],
    ["12. unknown token", `send 1 MON to ${A} and 2 DOGE to ${B}`, "UNSUPPORTED_TOKEN"],
    ["13. ambiguous: no amounts or token", "send money to alice and bob", "UNSUPPORTED_REQUEST"],
    ["13. ambiguous: swap with no destination", `send 1 MON to ${A} and swap 10 USDC`, "UNSUPPORTED_REQUEST"],
    ["a carried-over amount after a swap", `swap 10 MON to USDC and 2 USDC to ${A}`, "UNSUPPORTED_REQUEST"],
    ["a bound send after a transfer", `send 1 MON to ${A} and send it to ${B}`, "UNSUPPORTED_REQUEST"],
    ["a bound send of native MON", `swap 10 USDC to MON and send it to ${A}`, "NATIVE_OUTPUT_NOT_BINDABLE"],
    ["more actions than the resource ceiling (501)", Array.from({ length: 501 }, () => `send 1 MON to ${A}`).join(", "), "TOO_MANY_ACTIONS"],
    ["a dangling connector", `send 1 MON to ${A} and`, "UNSUPPORTED_REQUEST"],
    ["extra words in any clause", `send 1 MON to ${A} and send 2 MON to ${B} now`, "UNSUPPORTED_REQUEST"],
  ])("14. refuses (no plan, nothing partial): %s", async (_l, text, code) => {
    const r = await parse(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });
});

describe("draft: order is part of the plan", () => {
  const draftOf = async (text: string) => {
    const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
    const r = draftIntentGraph(text, { intentId: "intent_" + "c".repeat(24), wallet: WALLET, chainId: CHAIN });
    if (!r.ok) throw new Error(r.code);
    return r.draft;
  };
  it("each action depends on the one before it; swap-then-send keeps its one dependency", async () => {
    const d = await draftOf(`send 0.2 MON to ${A}, send 0.3 MON to ${B}, then swap 10 USDC to MON`);
    expect(d.nodes.map((n) => [n.nodeId, n.dependsOn])).toEqual([["n1", []], ["n2", ["n1"]], ["n3", ["n2"]]]);
    expect(d.source.text).toBe(`send 0.2 MON to ${A}, send 0.3 MON to ${B}, then swap 10 USDC to MON`);
    const ss = await draftOf(`swap 10 MON to USDC and send it to ${A}`);
    expect(ss.nodes[1].dependsOn).toEqual(["n1"]);
  });
  it("the validator accepts it and its step order is the written order", async () => {
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const v = validateIntentGraph(await draftOf(`swap 10 USDC to MON then send 5 MON to ${A} and 1 MON to ${B}`), { sessionWallet: WALLET, activeChainId: CHAIN });
    expect(v.ok && v.value.order).toEqual(["n1", "n2", "n3"]);
    expect(v.ok && v.value.nodes.map((n) => n.ref.actionId)).toEqual(["swap", "transfer", "transfer"]);
  });
});

/* ══ 2. One request → one plan, one review, one approval ════════════════════ */

describe("one plan through the real Plan API", () => {
  it("16 / 18. three actions become ONE plan whose review lists all three, and one approval covers them", async () => {
    const r = await routes();
    const text = `send 0.2 MON to ${A}, send 0.3 MON to ${B}, then swap 10 USDC to MON`;
    const c = await createPlanFromText(text, r.f);
    expect(c.status).toBe(200);
    const { plan, review } = c.body as { plan: PlanViewDTO; review: PlanReviewDTO };
    expect(review.steps.map((s) => [s.order, s.action])).toEqual([[1, "transfer"], [2, "transfer"], [3, "swap"]]);
    expect(review.reviewable).toBe(true);
    expect(plan.nodes).toHaveLength(3);
    expect(r.log.filter((l) => l === "plans:POST")).toHaveLength(1); // one plan, not one per action
    const a = await approvePlan(plan.planId, r.f);
    expect(a.status).toBe(200);
    const after = await view(plan.planId, r);
    expect(after.plan.approved).toBe(true);
    expect(after.plan.nodes.map((n) => n.state)).toEqual(["pending", "pending", "pending"]); // approved, nothing executed
    expect(planFoundText("multi", review.steps.length)).toBe("Here are your 3 actions, in order.");
  });
  it("15. an unparseable request creates no plan (422) — Ask falls back to its normal path", async () => {
    const r = await routes();
    const c = await createPlanFromText("send money to alice and bob", r.f);
    expect(c.status).toBe(422);
  });
  it("17. a retried turn reuses its plan instead of creating a second", async () => {
    const r = await routes();
    const text = `send 0.2 MON to ${A} and 0.3 MON to ${B}`;
    const since = Date.now();
    const first = await createPlanForTurn(text, { since, retry: false, fetch: r.f });
    const again = await createPlanForTurn(text, { since, retry: true, fetch: r.f });
    expect(again.data?.plan.planId).toBe(first.data?.plan.planId);
    expect(r.log.filter((l) => l === "plans:POST")).toHaveLength(1);
  });
});

/* ══ 3. Execution: the existing runner, in order, stopping at a failure ═════ */

describe("the existing runner executes every action, in order", () => {
  it("19 / 20. all actions run, built and signed one after another in the written order", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, ["1", "2", "3"]);
    const w = memoryWallet();
    const res = await run(planId, w, r);
    expect(res.outcome.kind).toBe("completed");
    expect(built).toEqual(["1", "2", "3"]);
    expect(w.sends).toBe(3);
    const v = await view(planId, r);
    expect(v.plan.state).toBe("completed");
    expect(v.plan.nodes.map((n) => n.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
  });

  it("21 / 22. action 1 succeeds, action 2 fails: 1 done, 2 failed, 3 never started — persisted", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, ["1", "2", "3"]);
    const w = memoryWallet();
    w.revertSend = 2;
    const res = await run(planId, w, r);
    expect(res.outcome.kind).toBe("reverted");
    expect(res.outcome.nodeId).toBe("n2");
    expect(built).toEqual(["1", "2"]); // action 3 was never even built
    expect(w.sends).toBe(2);
    const v = await view(planId, r);
    expect(v.plan.nodes.map((n) => n.state)).toEqual(["confirmed", "reverted", "skipped"]);
    expect(v.plan.state).toBe("partial");
    expect(planStatus(v.plan).label).toBe("Partly completed");
    // The existing classifier: never retry, and — because action 1 moved
    // funds — never "start a new plan" (it would repeat action 1).
    const cls = classifyOutcome(res.outcome);
    expect(cls.retry).toBe("DO_NOT_RETRY");
    expect(cls.action).toBe("check_wallet_activity");
    const shown = describeOutcome(res);
    expect(shown.canResume).toBe(false);
    expect(shown.showNewPlan).toBe(false);
    expect(canStartRun(v.plan, false, shown)).toBe(false);
  });

  it("23 / 24. running again — or after a refresh (fresh storage and locks) — never repeats action 1", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, ["1", "2", "3"]);
    const w = memoryWallet();
    w.revertSend = 2;
    const storage = memoryStorage();
    await run(planId, w, r, { storage });
    const sendsAfterFailure = w.sends;
    const again = await run(planId, w, r, { storage });
    const refreshed = await run(planId, w, r, { storage: memoryStorage(), locks: memoryLocks() });
    expect([again.outcome.kind, refreshed.outcome.kind]).toEqual(["reverted", "reverted"]);
    expect(w.sends).toBe(sendsAfterFailure);
    expect(built).toEqual(["1", "2"]);
    expect((await view(planId, r)).plan.nodes.map((n) => n.state)).toEqual(["confirmed", "reverted", "skipped"]);
  });

  it("a run interrupted after action 1 resumes at action 2 — action 1 is never rebuilt or re-signed", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, ["1", "2"]);
    const w = memoryWallet();
    const ac = new AbortController();
    // Abort as soon as the second build has been requested, before it is signed.
    const realBuild = (SEQ.actions[0] as unknown as { build: (i: Record<string, string>) => Promise<unknown> }).build;
    (SEQ.actions[0] as unknown as { build: (i: Record<string, string>) => Promise<unknown> }).build = async (i) => {
      if (i.amount === "2") ac.abort();
      return realBuild(i);
    };
    try {
      const first = await run(planId, w, r, { signal: ac.signal });
      expect(first.outcome.kind).toBe("aborted");
    } finally {
      (SEQ.actions[0] as unknown as { build: typeof realBuild }).build = realBuild;
    }
    const mid = await view(planId, r);
    expect(mid.plan.nodes[0].state).toBe("confirmed");
    const sendsBefore = w.sends;
    // Action 2's transaction had just been prepared when the run stopped: the
    // existing rule refuses a fresh quote until the pending-build window passes.
    const early = await run(planId, w, r, { storage: memoryStorage(), locks: memoryLocks() });
    expect(early.outcome.kind).toBe("step_not_ready");
    expect(w.sends).toBe(sendsBefore);
    const { PENDING_BUILD_WINDOW_MS } = await import("@/lib/plan/service");
    vi.setSystemTime(Date.now() + PENDING_BUILD_WINDOW_MS + 1_000);
    const second = await run(planId, w, r, { storage: memoryStorage(), locks: memoryLocks() });
    expect(second.outcome.kind).toBe("completed");
    expect(w.sends).toBe(sendsBefore + 1); // only action 2
    expect(built.filter((a) => a === "1")).toHaveLength(1);
  });

  it("25. a second tab can't run the plan while the first holds the lock: each action is signed once", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, ["1", "2"]);
    const w = memoryWallet();
    let open!: () => void;
    w.gate = new Promise<void>((res) => { open = res; });
    const locks = memoryLocks();
    const first = run(planId, w, r, { locks });
    await vi.waitFor(() => expect(w.sends).toBe(1));
    const second = await run(planId, w, r, { locks });
    expect(second.outcome.kind).toBe("already_running");
    open();
    expect((await first).outcome.kind).toBe("completed");
    expect(w.sends).toBe(2);
  });

  it("26. a signature requested and unresolved for an action blocks requote and restart of that action", async () => {
    const r = await routes();
    const planId = await approvedChain(r.http, ["1", "2"]);
    const w = memoryWallet();
    // The wallet throws after the signing intent is recorded for action 1.
    w.state.sendTransaction = async () => { w.sends++; throw new Error("wallet vanished mid-signature"); };
    const res = await run(planId, w, r, { storage: memoryStorage() });
    expect(["wallet_error", "signature_unresolved"]).toContain(res.outcome.kind);
    const again = await run(planId, memoryWallet(), r, { storage: memoryStorage(), locks: memoryLocks() });
    expect(again.outcome.kind).toBe("signature_unresolved");
    expect(built).toEqual(["1"]);
  });
});

/* ══ 4. Ask's hint: multi-action requests skip the model, others don't ═════ */

describe("Ask fast-path hint", () => {
  it("recognizes multi-action requests and counts their actions; keeps the single shapes", () => {
    expect(analyzePlanRequest(`send 0.2 MON to ${A}, send 0.3 MON to ${B}, then swap 10 USDC to MON`)).toEqual({ kind: "multi", actions: 3 });
    expect(analyzePlanRequest(`send 0.2 MON to ${A} and 0.3 MON to ${B}`)).toEqual({ kind: "multi", actions: 2 });
    expect(analyzePlanRequest(`swap 10 USDC to MON then send 5 MON to ${A}`)).toEqual({ kind: "multi", actions: 2 });
    expect(analyzePlanRequest(`send 0.1 MON to ${A}`)).toEqual({ kind: "transfer", actions: 1 });
    expect(analyzePlanRequest("swap 10 USDC to MON")).toEqual({ kind: "swap", actions: 1 });
    expect(analyzePlanRequest(`swap 10 MON to USDC and send it to ${A}`)).toEqual({ kind: "swap_send", actions: 2 });
  });
  it("anything the grammar can't take gets no hint (normal Ask path, with its clarifying questions)", () => {
    for (const t of ["send money to alice and bob", "send 0.2 to alice", "swap 10 USDC", `send 1 MON to ${A} and send it to ${B}`]) {
      expect(analyzePlanRequest(t), t).toBeNull();
    }
  });
  it("every multi-action shape the hint accepts, the server grammar accepts too", async () => {
    const { parseIntent } = await import("@/lib/plan-adapter/grammar");
    for (const t of [
      `send 0.2 MON to ${A}, send 0.3 MON to ${B}, then swap 10 USDC to MON`,
      `send 0.2 MON to ${A} and 0.3 MON to ${B}`,
      `send 1 USDC to ${A}, 2 USDC to ${B} and 3 USDC to ${C}`,
      `swap 10 USDC to MON then send 5 MON to ${A}`,
      "swap 10 MON to USDC and swap 5 USDC to MON",
      `send 1 MON to ${B}, then swap 10 MON to USDC and send the USDC to ${A}`,
    ]) {
      expect(analyzePlanRequest(t), t).not.toBeNull();
      expect(parseIntent(t, TOKENS).ok, t).toBe(true);
    }
  });
});
