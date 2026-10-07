import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Action, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";
import { runPlanInApp, type AppRunResult } from "@/lib/plans-client/app";
import { approvePlan, createPlanFromText, getPlanWithReview, listPlans, type PlanReviewDTO } from "@/lib/plans-client/api";
import type { PlanReview } from "@/lib/plan/review";
import { canApprove, canStartRun, describeOutcome } from "@/lib/plans-client/view";
import { classifyOutcome } from "@/lib/plans-client/outcomes";
import { JOURNAL_KEY_PREFIX } from "@/lib/plans-client/journal";
import { LOCK_NAME_PREFIX } from "@/lib/plans-client/locks";
import type { HttpFn, PlanViewDTO, RunOutcome, RunnerWallet } from "@/lib/plans-client/runner";

/**
 * The app's plan execution wiring (lib/plans-client/app.ts, view.ts, api.ts)
 * and the Plans screen's source boundary.
 *
 * Runs runPlanInApp — exactly what the Plans screen calls — against the REAL
 * plan, wallet-grant, build and confirm route handlers. Only the chain (RPC),
 * the payment policy and the wallet signature are stubbed; the lock manager
 * and localStorage are in-memory stand-ins for the browser's.
 */

const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const OTHER = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const TOKEN = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const TARGET = "0x00000000000000000000000000000000000000f1";
const RECIPIENT = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const CHAIN = 143;
const BASE = "https://app.usepayai.xyz";
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const chain = vi.hoisted(() => ({ txs: new Map<string, { from: string; to: string; input: string; value: bigint }>() }));
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
      const tx = chain.txs.get(hash);
      if (!tx) throw new Error("not found");
      return { status: "success", from: tx.from, logs: [] };
    },
    getTransaction: async ({ hash }: { hash: string }) => chain.txs.get(hash),
  }),
}));
vi.mock("@/lib/sdk/policy", () => ({
  enforcePaymentPolicy: async () => ({ allowed: true, warnings: [], riskScore: 5, riskLevel: "low", compliance: "approved" }),
}));

/** A one-step transfer fixture that reports a verified output. */
let buildSeq = 0;
const SENDX: ProtocolAdapter = {
  protocolId: "rapp-send", name: "rapp-send (app fixture)", chainId: CHAIN, allowedTargets: [TARGET],
  actions: [{
    version: "1.0.0", name: "transfer", description: "app fixture", protocolId: "rapp-send", chainId: CHAIN, allowedTargets: [TARGET],
    actionId: "transfer",
    inputSchema: {
      recipient: { type: "address", required: true, description: "to" },
      token: { type: "token", required: false, description: "token" },
      amount: { type: "units", required: true, description: "amount" },
    },
    outputs: { amount: { type: "units", description: "sent", denominatedIn: { input: "token" } } },
    async quote() { return { summary: "transfer quote", details: { Amount: "1000" }, quotedAt: Date.now(), terms: { kind: "transfer" } }; },
    async build() {
      return [{ kind: "action", label: "Send", tx: { to: TARGET, data: `0x5e${(++buildSeq).toString(16).padStart(8, "0")}`, value: "0" } }] as UnsignedActionStep[];
    },
    async confirmedOutputs() {
      return { outputs: { amount: { verified: true as const, type: "units" as const, value: "1000", token: TOKEN } }, denominations: { token: TOKEN } };
    },
    async parseResult() { return {}; },
    async outflows() { return []; },
  } as unknown as Action],
};

/* ══ The browser stand-ins ═════════════════════════════════════════════════ */

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** Web Locks semantics: exclusive per name, ifAvailable → callback(null) when held. */
function memoryLocks() {
  const held = new Set<string>();
  const names: string[] = [];
  return {
    names,
    async request(name: string, _o: { mode: "exclusive"; ifAvailable: true }, cb: (lock: unknown) => Promise<unknown>) {
      names.push(name);
      if (held.has(name)) return cb(null);
      held.add(name);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

/** The user's wallet. `mode` scripts what the final signature does. */
function memoryWallet(address = WALLET) {
  const w = {
    sends: 0,
    mode: "broadcast" as "broadcast" | "reject4001" | "throw",
    gate: null as Promise<void> | null,
    log: null as string[] | null,
    state: {
      address, chainId: CHAIN, isWrongNetwork: false,
      async sendTransaction(tx: { to: string; data?: string; value?: string }) {
        w.sends++;
        w.log?.push("SEND");
        if (w.gate) await w.gate;
        if (w.mode === "reject4001") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        if (w.mode === "throw") throw new Error("wallet disconnected");
        const hash = H(0xa00000 + w.sends);
        chain.txs.set(hash, { from: address, to: tx.to, input: tx.data ?? "0x", value: BigInt(tx.value ?? "0") });
        return hash;
      },
      async waitForReceipt() { return { status: "success" }; },
    } as RunnerWallet,
  };
  return w;
}

/** Same-origin requests into the real route handlers, with the browser's
 *  HttpOnly grant cookie for `grantFor`. `fail` makes chosen ops unreachable. */
async function routes(grantFor = WALLET) {
  const { encodeWalletGrant, WALLET_GRANT_COOKIE } = await import("@/lib/auth/walletGrant");
  const cookie = `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(grantFor, Date.now() + 3_600_000)}`;
  const h = { log: [] as string[], fail: new Set<string>() };
  const http: HttpFn = async (url, init) => {
    const u = new URL(url, BASE);
    let op: string = init.method ?? "GET";
    if (typeof init.body === "string") {
      try {
        const b = JSON.parse(init.body) as { op?: unknown };
        if (typeof b.op === "string") op = b.op;
      } catch { /* not JSON */ }
    }
    const label = u.pathname.startsWith("/api/plans/") ? `plan:${op}` : u.pathname === "/api/plans" ? `plans:${op}` : u.pathname;
    h.log.push(label);
    if (h.fail.has(label)) throw new TypeError("Failed to fetch");
    const req = new NextRequest(u, { method: init.method, headers: { ...(init.headers as Record<string, string>), cookie, "x-real-ip": "203.0.113.9" }, ...(init.body ? { body: init.body as string } : {}) });
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
  return { http, ...h };
}

/** An approved one-step plan, owned by WALLET. The fixture action isn't
 *  reviewable under Stage 5B, so approval is set up through the store (as in
 *  plan-runner's integration test); approval itself is covered below with a
 *  reviewable plan through the real route. */
async function approvedPlan(http: HttpFn, seq = 1): Promise<string> {
  const draft = {
    id: `intent_app_${String(seq).padStart(4, "0")}`, version: 1, chainId: CHAIN, wallet: WALLET, status: "draft",
    source: { text: `send 1000 to ${RECIPIENT}`, adapter: "deterministic", adapterVersion: "1" },
    nodes: [{
      nodeId: "n1", ref: { protocolId: "rapp-send", actionId: "transfer", version: "1.0.0" }, dependsOn: [],
      inputs: { recipient: { kind: "recipient", display: RECIPIENT, source: "address", address: RECIPIENT }, token: { kind: "literal", value: TOKEN }, amount: { kind: "literal", value: "1000" } },
      validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
    }],
  };
  const created = await http(`${BASE}/api/plans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft }), credentials: "same-origin", cache: "no-store" });
  expect(created.status).toBe(200);
  const planId = JSON.parse(await created.text()).plan.planId as string;
  const store = await import("@/lib/plan/store");
  await store.approvePlan(planId, { sessionWallet: WALLET, activeChainId: CHAIN });
  return planId;
}

const clock = { now: () => Date.now(), async sleep(ms: number) { vi.setSystemTime(Date.now() + ms); } };

function run(planId: string, w: ReturnType<typeof memoryWallet>, r: { http: HttpFn }, extra: Partial<Parameters<typeof runPlanInApp>[0]> = {}) {
  return runPlanInApp({
    planId, wallet: () => w.state, chainId: CHAIN, http: r.http, baseUrl: BASE, clock,
    storage: extra.storage ?? memoryStorage(), locks: extra.locks ?? memoryLocks(),
    ...extra,
  });
}

let savedNetwork: string | undefined;
beforeEach(async () => {
  savedNetwork = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  chain.txs.clear();
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
  registerProtocol(SENDX);
});
afterEach(() => {
  if (savedNetwork === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = savedNetwork;
  vi.useRealTimers();
});

/* ══ 1, 2, 10 — the screen's call runs the existing runner end to end ══════ */

describe("runPlanInApp drives the existing runner", () => {
  it("completes a plan: lock and journal bound to wallet + plan, intent before the one signature, then /tx, confirm, settle", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    r.log.length = 0;
    const w = memoryWallet();
    w.log = r.log;
    const storage = memoryStorage();
    const locks = memoryLocks();

    const res = await run(planId, w, r, { storage, locks });

    expect(res.outcome.kind).toBe("completed");
    expect(res.cls.kind).toBe("completed");
    expect(w.sends).toBe(1);
    // The lock is the existing runner's, for exactly this wallet + plan.
    expect(locks.names).toEqual([`${LOCK_NAME_PREFIX}${WALLET}:${planId}`]);
    // The runner's sequence, through the real routes. The grant is checked
    // first; the signing intent is recorded BEFORE the wallet is asked; /tx
    // only after the send.
    const seq = r.log.filter((l) => l !== "plan:GET");
    expect(seq.slice(0, 1)).toEqual(["/api/auth/wallet-grant"]);
    const at = (x: string) => seq.indexOf(x);
    expect(at("plan:intent")).toBeGreaterThan(at("/api/ask/action/build"));
    expect(at("SEND")).toBeGreaterThan(at("plan:intent"));
    expect(at("plan:tx")).toBeGreaterThan(at("SEND"));
    expect(at("/api/ask/action/confirm")).toBeGreaterThan(at("plan:tx"));
    expect(at("plan:settle")).toBeGreaterThan(at("/api/ask/action/confirm"));
    // The journal entry (bound to wallet + plan) was written and then cleared.
    expect([...storage.map.keys()].filter((k) => k.startsWith(JOURNAL_KEY_PREFIX))).toEqual([]);
    // 10. The screen's view of it.
    const v = describeOutcome(res);
    expect(v).toMatchObject({ completed: true, tone: "success", canResume: false, showNewPlan: false, checkWallet: false });
    expect(canStartRun(res.outcome.plan!, false, v)).toBe(false);
  });

  it("the quote review boundary is the screen's: decline builds and signs nothing", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    const w = memoryWallet();
    const seen: string[] = [];
    const res = await run(planId, w, r, { confirmQuote: async (q) => { seen.push(q.summary); return "decline"; } });
    expect(seen).toEqual(["transfer quote"]);
    expect(res.outcome.kind).toBe("quote_declined");
    expect(w.sends).toBe(0);
    expect(r.log).not.toContain("/api/ask/action/build");
    expect(describeOutcome(res).canResume).toBe(true); // nothing at stake: reviewing again is safe
  });
});

/* ══ 3 — duplicate execution ═══════════════════════════════════════════════ */

describe("a second run of the same plan is blocked by the existing lock", () => {
  it("while one run waits on the wallet, another gets already_running and sends nothing", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    const w = memoryWallet();
    let release!: () => void;
    w.gate = new Promise<void>((res) => { release = res; });
    const locks = memoryLocks();
    const storage = memoryStorage();
    let atWallet!: () => void;
    const reachedWallet = new Promise<void>((res) => { atWallet = res; });

    const first = run(planId, w, r, { locks, storage, onEvent: (e) => { if (e.phase === "waiting_for_wallet") atWallet(); } });
    await reachedWallet;
    const second = await run(planId, w, r, { locks, storage });
    expect(second.outcome.kind).toBe("already_running");
    expect(second.outcome.code).toBe("LOCK_HELD");
    expect(describeOutcome(second).canResume).toBe(false);

    release();
    expect((await first).outcome.kind).toBe("completed");
    expect(w.sends).toBe(1);
  });

  it("no usable lock manager → lock_unavailable, nothing sent, nothing called", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    r.log.length = 0;
    const w = memoryWallet();
    const res = await run(planId, w, r, { locks: null });
    expect(res.outcome.kind).toBe("lock_unavailable");
    expect(w.sends).toBe(0);
    expect(r.log).toEqual([]);
    expect(describeOutcome(res).canResume).toBe(false);
  });
});

/* ══ 4, 9 — a sent transaction is never sent again ═════════════════════════ */

describe("a journaled transaction is recovered, never re-sent", () => {
  it("/tx unreachable after the send → tx_unrecorded (check wallet, no resume); the next run records the SAME hash without signing", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    const w = memoryWallet();
    const storage = memoryStorage();

    r.fail.add("plan:tx");
    const first = await run(planId, w, r, { storage });
    expect(first.outcome.kind).toBe("tx_unrecorded");
    expect(first.outcome.journaled).toBe(true);
    expect(w.sends).toBe(1);
    const sentHash = first.outcome.txHash;
    expect(sentHash).toMatch(/^0x[0-9a-f]{64}$/);
    // 9. The screen surfaces wallet/activity recovery, not a retry.
    const v = describeOutcome(first);
    expect(v).toMatchObject({ checkWallet: true, canResume: false, showNewPlan: false, txHash: sentHash });
    expect(canStartRun({ ...first.outcome.plan!, planId }, false, v)).toBe(false);
    // The hash is in this browser's journal, bound to wallet + plan.
    expect(storage.getItem(`${JOURNAL_KEY_PREFIX}${WALLET}:${planId}`)).toContain(sentHash!);

    // Later (the plan reopened), the runner replays the journal: /tx records
    // the hash it already has, then confirm and settle. No second signature.
    r.fail.clear();
    const second = await run(planId, w, r, { storage });
    expect(second.outcome.kind).toBe("completed");
    expect(w.sends).toBe(1);
    expect(second.outcome.plan!.nodes[0].txHash).toBe(sentHash);
  });

  it("storage this browser can't keep a journal in → journal_unavailable before any request", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    r.log.length = 0;
    const w = memoryWallet();
    const broken = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
    const res = await run(planId, w, r, { storage: broken });
    expect(res.outcome.kind).toBe("journal_unavailable");
    expect(r.log).toEqual([]);
    expect(w.sends).toBe(0);
  });
});

/* ══ 5 — an unresolved signing intent ══════════════════════════════════════ */

describe("an unresolved signing intent blocks requote and restart", () => {
  it("an ambiguous wallet failure leaves the intent open; the next run stops at signature_unresolved without quoting or signing", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    const w = memoryWallet();
    w.mode = "throw";
    const first = await run(planId, w, r);
    expect(first.outcome.kind).toBe("wallet_error");
    expect(first.outcome.code).toBe("ACTION_SEND_FAILED");
    expect(describeOutcome(first)).toMatchObject({ checkWallet: true, canResume: false });

    w.mode = "broadcast";
    r.log.length = 0;
    const sendsBefore = w.sends;
    const second = await run(planId, w, r);
    expect(second.outcome.kind).toBe("signature_unresolved");
    expect(w.sends).toBe(sendsBefore);
    expect(r.log).not.toContain("plan:quote");
    expect(r.log).not.toContain("/api/ask/action/build");
    expect(describeOutcome(second)).toMatchObject({ checkWallet: true, canResume: false, showNewPlan: false });
  });
});

/* ══ 7 — wallet mismatch ═══════════════════════════════════════════════════ */

describe("the wallet must be the grant's (and so the plan's) wallet", () => {
  it("a connected wallet that isn't the granted one → wallet_mismatch: no plan call, no signature", async () => {
    const r = await routes(WALLET);
    const planId = await approvedPlan(r.http);
    r.log.length = 0;
    const w = memoryWallet(OTHER);
    const res = await run(planId, w, r);
    expect(res.outcome.kind).toBe("wallet_mismatch");
    expect(w.sends).toBe(0);
    expect(r.log).toEqual(["/api/auth/wallet-grant"]);
  });

  it("no wallet at all → wallet_locked before anything is created or called", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    r.log.length = 0;
    const res = await runPlanInApp({ planId, wallet: () => null, chainId: CHAIN, http: r.http, baseUrl: BASE, storage: memoryStorage(), locks: memoryLocks() });
    expect(res.outcome.kind).toBe("wallet_locked");
    expect(r.log).toEqual([]);
  });
});

/* ══ 8 — a rejected wallet action ══════════════════════════════════════════ */

describe("a wallet rejection follows the runner's outcome", () => {
  it("4001 → the attempt is released (nothing was sent) → wallet_rejected, safe to run again", async () => {
    const r = await routes();
    const planId = await approvedPlan(r.http);
    const w = memoryWallet();
    w.mode = "reject4001";
    const res: AppRunResult = await run(planId, w, r);
    expect(res.outcome.kind).toBe("wallet_rejected");
    expect(res.outcome.code).toBe("REJECTED_CODE");
    expect(r.log).toContain("plan:release");
    expect(describeOutcome(res)).toMatchObject({ checkWallet: false, canResume: true, showNewPlan: false });
  });
});

/* ══ 6 — partial execution never surfaces "start a new plan" ═══════════════ */

describe("the screen never offers a new plan once a step has executed", () => {
  const node = (nodeId: string, state: PlanViewDTO["nodes"][number]["state"], txHash: string | null) => ({
    nodeId, ref: { protocolId: "payai", actionId: "transfer", version: "1.0.0" }, dependsOn: [], state, quoteAttempts: 1,
    quoteId: "0".repeat(32), txHash, result: null, signing: null,
  });
  const outcomeWith = (kind: RunOutcome["kind"], nodes: ReturnType<typeof node>[], code: string | null = null): RunOutcome => ({
    kind, planId: `plan_${"b".repeat(32)}`, message: "m", nodeId: "n2", quoteId: null, txHash: null, approvalTxHashes: [], code, status: null, journaled: null,
    plan: { planId: `plan_${"b".repeat(32)}`, state: "partial", approved: true, abandoned: false, expired: false, approvable: false, createdAt: T0, approveBy: T0, expiresAt: T0 + 1, currentStep: "n2", nodes, recipients: {} },
  });

  it.each([
    ["quote_refused", "QUOTE_REFUSED"],
    ["abandoned", null],
    ["build_refused", "POLICY_BLOCKED"],
    ["reverted", null],
  ] as const)("step 1 confirmed, then %s on step 2 → check wallet activity, not a new plan", (kind, code) => {
    const o = outcomeWith(kind, [node("n1", "confirmed", H(1)), node("n2", kind === "reverted" ? "reverted" : "pending", kind === "reverted" ? H(2) : null)], code);
    const v = describeOutcome({ outcome: o, cls: classifyOutcome(o) });
    expect(v.showNewPlan).toBe(false);
    expect(v.canResume).toBe(false);
  });

  it("control: nothing executed and the quote was refused → a new plan is offered", () => {
    const o = outcomeWith("quote_refused", [node("n1", "pending", null)], "QUOTE_REFUSED");
    expect(describeOutcome({ outcome: o, cls: classifyOutcome(o) }).showNewPlan).toBe(true);
  });
});

/* ══ Review, approval and the screen's gates ═══════════════════════════════ */

describe("review and approval go through the existing Plan API", () => {
  it("a text request creates a reviewable plan; approve is offered, then the plan approves and is listed", async () => {
    // payai/transfer is available only with PayAI's forwarder configured
    // (the same env plan-intake.test.ts sets).
    const ENV = ["MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED"] as const;
    const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.MONAD_MAINNET_PAYAI_FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
    process.env.PAYAI_FORWARDER_ENABLED = "true";
    try {
      // Built-in actions read their availability when registered.
      const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
      const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
      __resetRegistryForTests();
      __resetBootstrapForTests();
      ensureBuiltinsRegistered();
      registerProtocol(SENDX);
      await textToApproval();
    } finally {
      for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  async function textToApproval() {
    const r = await routes();
    const fetchImpl = (url: string, init: RequestInit) => r.http(url, init as Parameters<HttpFn>[1]);
    const created = await createPlanFromText(`send 1 MON to ${RECIPIENT}`, fetchImpl);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const body = created.body as { plan: PlanViewDTO; review: { reviewable: boolean } };
    expect(body.review.reviewable).toBe(true);
    expect(canApprove(body.plan, body.review)).toBe(true);
    expect(canStartRun(body.plan, false, null)).toBe(false); // not approved yet

    const approved = await approvePlan(body.plan.planId, fetchImpl);
    expect(approved.status).toBe(200);
    const read = await getPlanWithReview(body.plan.planId, fetchImpl);
    const plan = (read.body as { plan: PlanViewDTO }).plan;
    expect(plan.approved).toBe(true);
    expect(canApprove(plan, (read.body as { review: { reviewable: boolean } }).review)).toBe(false);
    expect(canStartRun(plan, false, null)).toBe(true);
    expect(canStartRun(plan, true, null)).toBe(false); // never while a run is active

    const list = await listPlans(fetchImpl);
    expect((list.body as { plans: { planId: string }[] }).plans.map((p) => p.planId)).toContain(plan.planId);
  }

  it("an unreviewable plan is never offered approval", () => {
    expect(canApprove({ approvable: true, approved: false, abandoned: false, expired: false }, { reviewable: false })).toBe(false);
    expect(canApprove({ approvable: true, approved: false, abandoned: false, expired: false }, null)).toBe(false);
  });
});

/* ══ Source boundary: the UI reaches execution only through the runner ═════ */

describe("review DTO", () => {
  it("the client's review mirror stays assignable from the server's PlanReview (compile-time)", () => {
    const fromServer = (r: PlanReview): PlanReviewDTO => r; // fails to compile if the mirror drifts
    expect(typeof fromServer).toBe("function");
  });
});

describe("source boundary", () => {
  const root = join(__dirname, "..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(join(root, dir))) {
      const p = `${dir}/${name}`;
      if (statSync(join(root, p)).isDirectory()) out.push(...files(p));
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  const UI = [...files("app/dashboard/plans"), ...files("components/plans"), "lib/plans-client/api.ts", "lib/plans-client/view.ts"];

  it("the Plans screen executes through runPlanInApp", () => {
    expect(read("components/plans/PlansPanel.tsx")).toMatch(/import \{ runPlanInApp \} from "@\/lib\/plans-client\/app"/);
    expect(strip(read("components/plans/PlansPanel.tsx"))).toMatch(/runPlanInApp\(\{/);
  });

  it("no Plans UI file sends, signs, records or builds a transaction itself", () => {
    const banned: [string, RegExp][] = [
      ["a wallet send", /\bsendTransaction(From)?\s*\(/],
      ["a receipt wait", /\bwaitForReceipt\s*\(/],
      ["calldata", /encodeFunctionData|writeContract/],
      ["the SDK build/confirm routes", /\/api\/ask\/action/],
      ["a runner-only Plan API op", /op:\s*["'](next|quote|bind|tx|intent|release|settle)["']/],
      ["its own runner", /createPlanRunner|createHttpTransports|createLocalJournal|createWebExecutionLock/],
    ];
    for (const f of UI) {
      const src = strip(read(f));
      for (const [what, re] of banned) expect(src, `${f} must not contain ${what}`).not.toMatch(re);
    }
  });

  it("outside lib/plans-client, nothing in the app creates a runner; app.ts wires the existing lock, journal and storage probe", () => {
    const appCode = [...files("app"), ...files("components"), ...files("lib")].filter((f) => !f.startsWith("lib/plans-client/"));
    for (const f of appCode) expect(strip(read(f)), f).not.toMatch(/createPlanRunner\s*\(/);
    const wiring = strip(read("lib/plans-client/app.ts"));
    expect(wiring).toMatch(/createPlanRunner\(\{/);
    expect(wiring).toMatch(/createLocalJournal\(/);
    expect(wiring).toMatch(/createWebExecutionLock\(/);
    expect(wiring).toMatch(/probeStorage\(/);
    expect(wiring).not.toMatch(/\bsendTransaction\s*\(/);
  });

  it("the app's plan code imports the client runner from the real application path", () => {
    const importers = [...files("app"), ...files("components")].filter((f) => /from "@\/lib\/plans-client\//.test(read(f)));
    expect(importers).toContain("components/plans/PlansPanel.tsx");
  });
});
