import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeFunctionData } from "viem";
import type { Action, ActionInputs, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";
import type { WalletServiceState } from "@/lib/wallet-service/WalletServiceContext";
import type { BoundQuote, NextStep, PlanView, StepQuote } from "@/lib/plan/service";
import {
  createHttpTransports, createPlanRunner, isUserRejection, journalEntriesFor, PlanRunnerConfigError, SETTLE_POLL_CAP_MS,
  type QuoteDecision, type QuoteProjection, type RunnerEvent,
  type BoundQuoteDTO, type BuildStepDTO, type ExecutionLockResult, type Clock, type HttpFn, type JournalEntry, type NextStepDTO,
  type NodeStateDTO, type PlanRunnerDeps, type PlanStateDTO, type PlanTransport, type PlanViewDTO, type Reply,
  type RunnerWallet, type SdkTransport, type StepQuoteDTO,
} from "@/lib/plans-client/runner";
import { createLocalJournal } from "@/lib/plans-client/journal";
import { createWebExecutionLock } from "@/lib/plans-client/locks";

/**
 * Phase 2C Stage 4B — the headless client-side Plan Runner
 * (lib/plans-client/runner.ts).
 *
 * Unit tests drive the runner against a small in-memory fake of the Plan API
 * and SDK routes that mirrors the server's derived-state rules; the server's
 * own behaviour (guard, bind freshness, recordTx/settle rules, build gates,
 * confirm verdicts and outputs) is already covered by plan-service,
 * plan-api, sdk-protocol-action-build, sdk-confirmed-outputs and
 * ask-submitted-state tests, and is not re-tested here.
 *
 * One integration test at the end runs the runner's own HTTP adapter against
 * the REAL plan, build, confirm and wallet-grant route handlers, with only the
 * chain (RPC), the payment policy and the wallet signature stubbed.
 */

const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const OTHER = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const TOKEN = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const TARGET = "0x00000000000000000000000000000000000000f1";
const CHAIN = 143;
const PLAN = `plan_${"a".repeat(32)}`;
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const REF = { protocolId: "payai", actionId: "transfer", version: "1.0.0" };
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const QID = (n: number) => n.toString(16).padStart(32, "0");

/* ══ The fake world ════════════════════════════════════════════════════════ */

type Verdict = "success" | "reverted" | "unverified";
type Op = "getPlan" | "next" | "quote" | "bind" | "tx" | "settle" | "build" | "confirm";
interface NodeSpec { nodeId: string; dependsOn?: string[]; approve?: boolean }
interface FakeNode {
  nodeId: string; dependsOn: string[]; approve: boolean;
  quoteId: string | null; quotes: number; txHash: string | null; quotedAt?: number;
  result: { status: "confirmed" | "reverted" | "unverified"; outputs: null } | null;
}

const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...body } });
const err = (status: number, code: string, message = code): Reply => ({ status, body: { ok: false, code, message } });

/**
 * A fake ExecutionLock: exclusive per wallet + plan over a shared `held` set
 * (pass several runners the same one to contend), released when the task
 * settles. `mode` scripts the other results.
 */
function fakeLock(held = new Set<string>()) {
  const lk = {
    held,
    mode: "pass" as "pass" | "held" | "unavailable" | "throw",
    scopes: [] as { wallet: string; planId: string }[],
    async runExclusive<T>(scope: { wallet: string; planId: string }, task: () => Promise<T>): Promise<ExecutionLockResult<T>> {
      lk.scopes.push({ ...scope });
      if (lk.mode === "held") return { status: "held" };
      if (lk.mode === "unavailable") return { status: "unavailable" };
      if (lk.mode === "throw") throw new Error("SecurityError: locks blocked");
      const key = `${scope.wallet}:${scope.planId}`;
      if (lk.held.has(key)) return { status: "held" };
      lk.held.add(key);
      try {
        return { status: "ran", value: await task() };
      } finally {
        lk.held.delete(key);
      }
    },
  };
  return lk;
}

function world(specs: NodeSpec[] = [{ nodeId: "n1" }], o: { planId?: string; lock?: ReturnType<typeof fakeLock> } = {}) {
  const PID = o.planId ?? PLAN;
  const log: string[] = [];
  const t = { now: T0, sleeps: [] as number[] };
  const clock: Clock = {
    now: () => t.now,
    async sleep(ms) { t.sleeps.push(ms); log.push(`sleep:${ms}`); t.now += ms; },
  };
  const flags = { approved: true, abandoned: false };
  const nodes: FakeNode[] = specs.map((s) => ({ nodeId: s.nodeId, dependsOn: s.dependsOn ?? [], approve: !!s.approve, quoteId: null, quotes: 0, txHash: null, result: null }));
  const byId = (id: string) => nodes.find((n) => n.nodeId === id)!;
  /** Verdicts the confirm route has stored, by tx hash. */
  const verdicts = new Map<string, Verdict>();
  /** What a terminal confirm yields for a node (default success). */
  const outcomeOf = new Map<string, Verdict>();
  /** Scripted confirm replies (consumed in order) before the terminal one. */
  const confirmScript: (Reply | "throw" | ((t: { now: number }) => Reply))[] = [];
  /** Per-op overrides: return a Reply to replace the default, undefined to fall through. */
  const ov: Partial<Record<Op, (...a: never[]) => Reply | undefined>> = {};
  const counts: Record<Op, number> = { getPlan: 0, next: 0, quote: 0, bind: 0, tx: 0, settle: 0, build: 0, confirm: 0 };
  const seen = { builds: [] as unknown[], confirms: [] as unknown[], txs: [] as { nodeId: string; quoteId: string; txHash: string }[] };
  let qseq = 0;

  const FAILED = ["reverted", "unverified", "skipped"];
  const stateOf = (n: FakeNode): NodeStateDTO => {
    if (n.result) return n.result.status;
    if (n.txHash) return "submitted";
    if (n.dependsOn.some((d) => FAILED.includes(stateOf(byId(d))))) return "skipped";
    if (flags.abandoned) return "skipped";
    if (n.quoteId && flags.approved) return "awaiting_signature";
    return "pending";
  };
  const current = () => nodes.find((n) => !["confirmed", "skipped"].includes(stateOf(n))) ?? null;
  const planState = (): PlanStateDTO => {
    const all = nodes.map(stateOf);
    if (all.every((s) => s === "confirmed")) return "completed";
    if (all.every((s) => ["confirmed", ...FAILED].includes(s))) return all.includes("confirmed") ? "partial" : "failed";
    if (nodes.some((n) => n.quotes > 0 || n.txHash || n.result)) return "running";
    return flags.approved ? "approved" : "planned";
  };
  const view = (): PlanViewDTO => ({
    planId: PID, state: planState(), approved: flags.approved, abandoned: flags.abandoned, expired: false, approvable: false,
    createdAt: T0, approveBy: T0, expiresAt: T0 + 7 * 86_400_000, currentStep: current()?.nodeId ?? null,
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId, ref: { ...REF }, dependsOn: [...n.dependsOn], state: stateOf(n), quoteAttempts: n.quotes,
      quoteId: n.quoteId, txHash: n.txHash, result: n.result ? { ...n.result } : null,
    })),
    recipients: {},
  });
  const quotable = (n: FakeNode) => !flags.abandoned && n.dependsOn.every((d) => stateOf(byId(d)) === "confirmed") && ["pending", "awaiting_signature"].includes(stateOf(n));
  const hook = (op: Op, ...a: unknown[]) => { counts[op]++; const f = ov[op] as ((...x: unknown[]) => Reply | undefined) | undefined; return f?.(...a); };

  const plans: PlanTransport = {
    async getPlan() { log.push("getPlan"); return hook("getPlan") ?? ok({ plan: view() }); },
    async next() {
      log.push("next");
      const o = hook("next"); if (o) return o;
      if (!flags.approved) return err(409, "NOT_APPROVED");
      const c = current();
      if (!c) return err(409, "STEP_NOT_READY");
      return ok({ next: { nodeId: c.nodeId, ref: { ...REF }, state: stateOf(c), quotable: quotable(c) } });
    },
    async quote(_p, nodeId) {
      log.push(`quote:${nodeId}`);
      const o = hook("quote", nodeId); if (o) return o;
      if (!flags.approved) return err(409, "NOT_APPROVED");
      const n = byId(nodeId);
      if (current() !== n || !quotable(n)) return err(409, "STEP_NOT_READY");
      n.quotes++;
      n.quoteId = QID(++qseq);
      n.quotedAt = t.now;
      return ok({ quote: { nodeId, ref: { ...REF }, attempt: n.quotes, quoteId: n.quoteId, quoteToken: `tok-${n.quoteId}`, inputs: { amount: "100", recipient: OTHER }, summary: "s", details: {}, quotedAt: t.now } });
    },
    async bind(_p, nodeId, token) {
      log.push(`bind:${nodeId}`);
      const o = hook("bind", nodeId, token); if (o) return o;
      const n = byId(nodeId);
      if (token !== `tok-${n.quoteId}`) return err(404, "NOT_FOUND");
      // Like the server: fresh for 90s from the quote, and refused after.
      const quotedAt = n.quotedAt ?? t.now;
      if (t.now - quotedAt > 90_000) return err(410, "EXPIRED");
      return ok({ bound: { nodeId, ref: { ...REF }, attempt: n.quotes, quoteId: n.quoteId, quotedAt, freshUntil: quotedAt + 90_000 } });
    },
    async tx(_p, nodeId, input) {
      log.push(`tx:${nodeId}:${input.txHash}`);
      seen.txs.push({ nodeId, ...input });
      const o = hook("tx", nodeId, input); if (o) return o;
      const n = byId(nodeId);
      if (n.txHash && n.txHash !== input.txHash) return err(409, "CONFLICT");
      n.txHash = input.txHash;
      return ok({ plan: view() });
    },
    async settle(_p, nodeId) {
      log.push(`settle:${nodeId}`);
      const o = hook("settle", nodeId); if (o) return o;
      const n = byId(nodeId);
      if (!n.txHash) return err(404, "NOT_FOUND");
      if (!n.result) {
        const v = verdicts.get(n.txHash);
        if (!v) return err(202, "SETTLEMENT_PENDING");
        n.result = { status: v === "success" ? "confirmed" : v, outputs: null };
      }
      return ok({ plan: view() });
    },
  };

  const steps = (n: FakeNode) => [
    ...(n.approve ? [{ kind: "approve", label: "Approve", tx: { to: TOKEN, data: `0x095ea7b3${"00".repeat(64)}`, value: "0" } }] : []),
    { kind: "action", label: "Act", tx: { to: TARGET, data: "0xabcdef01", value: "0" } },
  ];
  const sdk: SdkTransport = {
    async build(req) {
      log.push("build");
      seen.builds.push(req);
      const o = hook("build", req); if (o) return o;
      const quoteId = req.quoteToken.slice(4);
      const n = nodes.find((x) => x.quoteId === quoteId) ?? nodes[0];
      return ok({ steps: steps(n), quoteId, summary: "s", details: {} });
    },
    async confirm(req) {
      log.push(`confirm:${req.txHash}`);
      seen.confirms.push(req);
      const o = hook("confirm", req); if (o) return o;
      const scripted = confirmScript.shift();
      if (scripted === "throw") throw new Error("Failed to fetch");
      if (scripted) return typeof scripted === "function" ? scripted(t) : scripted;
      const n = nodes.find((x) => x.txHash === req.txHash);
      const v = (n && outcomeOf.get(n.nodeId)) ?? "success";
      verdicts.set(req.txHash, v);
      if (v === "success") return ok({ success: true, explorerUrl: "x", details: {} });
      if (v === "reverted") return { status: 200, body: { ok: false, reverted: true, message: "reverted" } };
      return { status: 200, body: { ok: false, verified: false, message: "unverified" } };
    },
  };

  let hseq = 0;
  const wallet = {
    address: WALLET as string | null,
    chainId: CHAIN as number | null,
    isWrongNetwork: false,
    sent: [] as { to: string; data?: string; value?: string }[],
    sendQueue: [] as ((tx: unknown) => Promise<string>)[],
    receiptFor: new Map<string, () => Promise<unknown>>(),
    async sendTransaction(tx: { to: string; data?: string; value?: string }) {
      log.push(tx.to === TOKEN ? "sign:approve" : "sign:action");
      wallet.sent.push(tx);
      const f = wallet.sendQueue.shift();
      if (f) return f(tx);
      return H(++hseq);
    },
    async waitForReceipt(hash: string) {
      log.push(`receipt:${hash}`);
      const f = wallet.receiptFor.get(hash);
      return f ? f() : { status: "success" };
    },
  };
  const grant = { address: WALLET as string | null, fail: false, async currentAddress() { log.push("grant"); if (grant.fail) throw new Error("offline"); return grant.address; } };
  const journal = {
    entries: new Map<string, JournalEntry>(),
    failSave: false, failLoad: false,
    async save(e: JournalEntry) { log.push(`journal:save:${e.txHash}`); if (journal.failSave) throw new Error("quota"); journal.entries.set(e.nodeId, { ...e }); },
    async load(planId: string) { log.push("journal:load"); if (journal.failLoad) throw new Error("blocked"); return [...journal.entries.values()].filter((e) => e.planId === planId); },
    async clear(_p: string, nodeId: string) { log.push(`journal:clear:${nodeId}`); journal.entries.delete(nodeId); },
  };
  const lock = o.lock ?? fakeLock();
  const deps = (d: Partial<PlanRunnerDeps> = {}): PlanRunnerDeps => ({ wallet, plans, sdk, grant, clock, journal, lock, chainId: CHAIN, ...d });
  const runner = (d: Partial<PlanRunnerDeps> = {}) => createPlanRunner(deps(d));
  const run = (d: Partial<PlanRunnerDeps> = {}) => runner(d).run(PID);
  return { log, t, clock, flags, nodes, byId, verdicts, outcomeOf, confirmScript, ov, counts, seen, plans, sdk, wallet, grant, journal, lock, deps, runner, run, view };
}
type World = ReturnType<typeof world>;
const signs = (w: World) => w.log.filter((l) => l.startsWith("sign:"));

/* ══ Happy paths and sequencing ════════════════════════════════════════════ */

describe("happy path", () => {
  it("one node: grant → journal → plan → next → quote → bind → build → pre-sign → sign → journal → /tx → receipt → confirm → settle", async () => {
    const w = world();
    const r = await w.run();
    expect(r.kind).toBe("completed");
    expect(w.log).toEqual([
      "grant", "journal:load", "getPlan", "next", "quote:n1", "bind:n1", "build",
      "getPlan", "grant", "sign:action", `journal:save:${H(1)}`, `tx:n1:${H(1)}`, "journal:clear:n1",
      `receipt:${H(1)}`, `confirm:${H(1)}`, "settle:n1",
      "grant", "journal:load", "getPlan",
    ]);
    expect(r.plan?.state).toBe("completed");
    expect(w.journal.entries.size).toBe(0);
  });

  it("build gets exactly the quote's ref, inputs and token plus the GRANT wallet; confirm gets the same quoteId and the final hash", async () => {
    const w = world();
    w.grant.address = WALLET.toUpperCase().replace("0X", "0x"); // case-insensitive match
    expect((await w.run()).kind).toBe("completed");
    const q = w.byId("n1").quoteId!;
    expect(w.seen.builds).toEqual([{ ...REF, inputs: { amount: "100", recipient: OTHER }, walletAddress: WALLET, quoteToken: `tok-${q}` }]);
    expect(w.seen.confirms).toEqual([{ ...REF, txHash: H(1), walletAddress: WALLET, quoteId: q }]);
    expect(w.seen.txs).toEqual([{ nodeId: "n1", quoteId: q, txHash: H(1) }]);
  });

  it("the build steps go to the wallet exactly as returned — nothing is constructed or altered", async () => {
    const w = world([{ nodeId: "n1", approve: true }]);
    await w.run();
    expect(w.wallet.sent).toEqual([
      { to: TOKEN, data: `0x095ea7b3${"00".repeat(64)}`, value: "0" },
      { to: TARGET, data: "0xabcdef01", value: "0" },
    ]);
  });

  it("multi-node: a dependent step is quoted only after its dependency CONFIRMED", async () => {
    const w = world([{ nodeId: "n1" }, { nodeId: "n2", dependsOn: ["n1"] }]);
    const r = await w.run();
    expect(r.kind).toBe("completed");
    expect(w.log.indexOf("quote:n2")).toBeGreaterThan(w.log.indexOf("settle:n1"));
    expect(w.seen.txs.map((x) => x.nodeId)).toEqual(["n1", "n2"]);
    expect(w.byId("n1").result?.status).toBe("confirmed");
    expect(w.byId("n2").result?.status).toBe("confirmed");
  });

  it("a reverted or unverified step stops: the dependent is never quoted, built or signed", async () => {
    for (const v of ["reverted", "unverified"] as const) {
      const w = world([{ nodeId: "n1" }, { nodeId: "n2", dependsOn: ["n1"] }]);
      w.outcomeOf.set("n1", v);
      const r = await w.run();
      expect(r.kind).toBe(v);
      expect(r).toMatchObject({ nodeId: "n1", txHash: H(1) });
      expect(w.counts.quote).toBe(1);
      expect(signs(w)).toEqual(["sign:action"]);
      expect(w.view().nodes[1].state).toBe("skipped");
    }
  });
});

/* ══ Identity: grant, wallet, network ══════════════════════════════════════ */

describe("identity before anything else", () => {
  it("no grant → grant_required; nothing else is called", async () => {
    const w = world();
    w.grant.address = null;
    expect((await w.run()).kind).toBe("grant_required");
    expect(w.log).toEqual(["grant"]);
  });
  it("grant lookup failing → network_error", async () => {
    const w = world();
    w.grant.fail = true;
    expect((await w.run()).kind).toBe("network_error");
    expect(w.counts.getPlan).toBe(0);
  });
  it("signer ≠ grant → wallet_mismatch", async () => {
    const w = world();
    w.grant.address = OTHER;
    expect((await w.run()).kind).toBe("wallet_mismatch");
    expect(w.counts.getPlan).toBe(0);
  });
  it("wrong network (chainId or isWrongNetwork) → wrong_network", async () => {
    const a = world();
    a.wallet.chainId = 1;
    expect((await a.run()).kind).toBe("wrong_network");
    const b = world();
    b.wallet.isWrongNetwork = true;
    expect((await b.run()).kind).toBe("wrong_network");
    const c = world();
    c.wallet.chainId = null;
    expect((await c.run()).kind).toBe("wrong_network");
  });
  it("locked wallet (no address) → wallet_locked", async () => {
    const w = world();
    w.wallet.address = null;
    expect((await w.run()).kind).toBe("wallet_locked");
  });
});

/* ══ Plan state, next and quote ════════════════════════════════════════════ */

describe("plan state, next and quote — typed stops, no automatic retry", () => {
  it("not approved → not_approved (the runner never approves)", async () => {
    const w = world();
    w.flags.approved = false;
    expect((await w.run()).kind).toBe("not_approved");
    expect(w.counts.next).toBe(0);
  });
  it("expired plan (410) → expired, from GET or from quote", async () => {
    const a = world();
    a.ov.getPlan = () => err(410, "EXPIRED");
    expect((await a.run()).kind).toBe("expired");
    const b = world();
    b.ov.quote = () => err(410, "EXPIRED");
    expect((await b.run()).kind).toBe("expired");
    expect(b.counts.build).toBe(0);
  });
  it("abandoned plan → abandoned; nothing quoted", async () => {
    const w = world();
    w.flags.abandoned = true;
    expect((await w.run()).kind).toBe("abandoned");
    expect(w.counts.quote).toBe(0);
  });
  it("abandoned plan with a submitted step: the step still settles (no signing), then abandoned", async () => {
    const w = world([{ nodeId: "n1" }, { nodeId: "n2", dependsOn: ["n1"] }]);
    Object.assign(w.byId("n1"), { quoteId: QID(9), quotes: 1, txHash: H(9) });
    w.flags.abandoned = true;
    const r = await w.run();
    expect(r.kind).toBe("abandoned");
    expect(w.byId("n1").result?.status).toBe("confirmed");
    expect(signs(w)).toEqual([]);
    expect(w.counts.quote).toBe(0);
  });
  it("next says not quotable → step_not_ready with the server's reason; no quote", async () => {
    const w = world();
    w.ov.next = () => ok({ next: { nodeId: "n1", ref: REF, state: "pending", quotable: false, reason: "A step this one depends on hasn't confirmed." } });
    const r = await w.run();
    expect(r).toMatchObject({ kind: "step_not_ready", nodeId: "n1", message: "A step this one depends on hasn't confirmed." });
    expect(w.counts.quote).toBe(0);
  });
  it("next 409 NOT_APPROVED / STEP_NOT_READY map to their kinds", async () => {
    const a = world();
    a.ov.next = () => err(409, "NOT_APPROVED");
    expect((await a.run()).kind).toBe("not_approved");
    const b = world();
    b.ov.next = () => err(409, "STEP_NOT_READY");
    expect((await b.run()).kind).toBe("step_not_ready");
  });
  it("QUOTE_REFUSED (422) → quote_refused; quoted once, never built", async () => {
    const w = world();
    w.ov.quote = () => err(422, "QUOTE_REFUSED", "Payment blocked.");
    const r = await w.run();
    expect(r).toMatchObject({ kind: "quote_refused", code: "QUOTE_REFUSED", status: 422, message: "Payment blocked." });
    expect(w.counts.quote).toBe(1);
    expect(w.counts.build).toBe(0);
  });
  it("STEP_NOT_READY from quote (the Phase 4A pending-build guard) → step_not_ready; no re-quote, no build", async () => {
    const w = world();
    w.ov.quote = () => err(409, "STEP_NOT_READY", "This step's last quote was just prepared for signing.");
    expect((await w.run()).kind).toBe("step_not_ready");
    expect(w.counts.quote).toBe(1);
    expect(w.counts.build).toBe(0);
  });
  it("CONFLICT from quote → conflict; 401 → grant_required; 429 → rate_limited; 503 → unavailable; 502 → server_error", async () => {
    const cases: [Reply, string][] = [
      [err(409, "CONFLICT"), "conflict"], [err(401, "wallet_grant_required"), "grant_required"], [{ status: 429, body: { error: "slow down" } }, "rate_limited"],
      [err(503, "UNAVAILABLE"), "unavailable"], [err(502, "INTERNAL_ERROR"), "server_error"], [{ status: 0, body: null }, "network_error"],
    ];
    for (const [reply, kind] of cases) {
      const w = world();
      w.ov.quote = () => reply;
      expect((await w.run()).kind).toBe(kind);
      expect(w.counts.quote).toBe(1);
      expect(w.counts.build).toBe(0);
    }
  });
  it("an already completed plan → completed without any step call", async () => {
    const w = world();
    Object.assign(w.byId("n1"), { quoteId: QID(1), quotes: 1, txHash: H(1), result: { status: "confirmed", outputs: null } });
    expect((await w.run()).kind).toBe("completed");
    expect(w.counts.next).toBe(0);
  });
  it("a malformed plan view → invalid_response", async () => {
    const w = world();
    w.ov.getPlan = () => ok({ plan: { planId: PLAN, state: "weird" } });
    expect((await w.run()).kind).toBe("invalid_response");
  });
});

/* ══ Bind and build ════════════════════════════════════════════════════════ */

describe("bind", () => {
  it("expired (410) or not quotable (409) or superseded (404) → bind_failed with the code; never built", async () => {
    for (const [reply, code] of [[err(410, "EXPIRED"), "EXPIRED"], [err(409, "STEP_NOT_READY"), "STEP_NOT_READY"], [err(404, "NOT_FOUND"), "NOT_FOUND"]] as const) {
      const w = world();
      w.ov.bind = () => reply;
      expect(await w.run()).toMatchObject({ kind: "bind_failed", code });
      expect(w.counts.build).toBe(0);
    }
  });
  it("a bound quote already past freshUntil (by the injected clock) → bind_failed EXPIRED", async () => {
    const w = world();
    w.ov.bind = () => ok({ bound: { nodeId: "n1", ref: REF, attempt: 1, quoteId: w.byId("n1").quoteId, quotedAt: T0 - 90_000, freshUntil: T0 } });
    expect(await w.run()).toMatchObject({ kind: "bind_failed", code: "EXPIRED" });
    expect(w.counts.build).toBe(0);
  });
  it("a bound quote for a different quoteId → bind_failed", async () => {
    const w = world();
    w.ov.bind = () => ok({ bound: { nodeId: "n1", ref: REF, attempt: 1, quoteId: QID(77), quotedAt: T0, freshUntil: T0 + 90_000 } });
    expect(await w.run()).toMatchObject({ kind: "bind_failed", code: "QUOTE_MISMATCH" });
  });
});

describe("build — judged by `ok`, then by identity and step shape; never signed when off", () => {
  const cases: [string, (w: World) => Reply, string, string | null][] = [
    ["HTTP 200 with ok:false", () => err(200, "FEE_TERMS_CHANGED"), "build_refused", "FEE_TERMS_CHANGED"],
    ["HTTP 200 with ok:false (QUOTE_CHANGED)", () => err(200, "QUOTE_CHANGED"), "build_refused", "QUOTE_CHANGED"],
    ["ALREADY_BUILT (409)", () => err(409, "ALREADY_BUILT"), "build_refused", "ALREADY_BUILT"],
    ["502 generic", () => ({ status: 502, body: { ok: false, message: "Couldn't prepare that action." } }), "build_refused", null],
    ["quoteId mismatch", () => ok({ steps: [{ kind: "action", label: "a", tx: { to: TARGET, data: "0x", value: "0" } }], quoteId: QID(99) }), "build_invalid", "QUOTE_MISMATCH"],
    ["empty steps", (w) => ok({ steps: [], quoteId: w.byId("n1").quoteId }), "build_invalid", "MALFORMED_STEPS"],
    ["final step is an approval", (w) => ok({ steps: [{ kind: "approve", label: "a", tx: { to: TOKEN, data: "0x", value: "0" } }], quoteId: w.byId("n1").quoteId }), "build_invalid", "MALFORMED_STEPS"],
    ["an action before the final step", (w) => ok({ steps: [{ kind: "action", label: "a", tx: { to: TARGET, data: "0x", value: "0" } }, { kind: "action", label: "b", tx: { to: TARGET, data: "0x", value: "0" } }], quoteId: w.byId("n1").quoteId }), "build_invalid", "MALFORMED_STEPS"],
    ["malformed target", (w) => ok({ steps: [{ kind: "action", label: "a", tx: { to: "0x123", data: "0x", value: "0" } }], quoteId: w.byId("n1").quoteId }), "build_invalid", "MALFORMED_STEPS"],
  ];
  for (const [name, reply, kind, code] of cases) {
    it(`${name} → ${kind}`, async () => {
      const w = world();
      w.ov.build = () => reply(w);
      const r = await w.run();
      expect(r).toMatchObject({ kind, code });
      expect(signs(w)).toEqual([]);
      expect(w.counts.quote).toBe(1);
      expect(w.counts.tx).toBe(0);
    });
  }
  it("build network failure → network_error, nothing signed, no re-quote", async () => {
    const w = world();
    w.ov.build = () => { throw new Error("Failed to fetch"); };
    expect((await w.run()).kind).toBe("network_error");
    expect(signs(w)).toEqual([]);
    expect(w.counts.quote).toBe(1);
  });
});

/* ══ Pre-sign re-check ═════════════════════════════════════════════════════ */

describe("pre-sign re-check — abort with zero sendTransaction calls", () => {
  it("the step was re-quoted elsewhere (quoteId changed) → conflict QUOTE_SUPERSEDED", async () => {
    const w = world();
    w.ov.build = () => { w.byId("n1").quoteId = QID(500); return undefined; };
    expect(await w.run()).toMatchObject({ kind: "conflict", code: "QUOTE_SUPERSEDED" });
    expect(w.wallet.sent).toEqual([]);
  });
  it("a txHash is already recorded → conflict TX_ALREADY_RECORDED", async () => {
    const w = world();
    w.ov.build = () => { w.byId("n1").txHash = H(99); return undefined; };
    expect(await w.run()).toMatchObject({ kind: "conflict", code: "TX_ALREADY_RECORDED" });
    expect(w.wallet.sent).toEqual([]);
  });
  it("the plan was abandoned / became unapproved meanwhile", async () => {
    const a = world();
    a.ov.build = () => { a.flags.abandoned = true; return undefined; };
    expect((await a.run()).kind).toBe("abandoned");
    expect(a.wallet.sent).toEqual([]);
    const b = world();
    b.ov.build = () => { b.flags.approved = false; return undefined; };
    expect((await b.run()).kind).toBe("not_approved");
    expect(b.wallet.sent).toEqual([]);
  });
  it("the wallet switched account, network, or locked meanwhile (read live through a getter)", async () => {
    const mutations: [(w: World) => void, string][] = [
      [(w) => { w.wallet.address = OTHER; }, "wallet_mismatch"],
      [(w) => { w.grant.address = OTHER; w.wallet.address = OTHER; }, "wallet_mismatch"],
      [(w) => { w.wallet.chainId = 10; }, "wrong_network"],
      [(w) => { w.wallet.address = null; }, "wallet_locked"],
      [(w) => { w.grant.address = null; }, "grant_required"],
    ];
    for (const [mutate, kind] of mutations) {
      const w = world();
      w.ov.build = () => { mutate(w); return undefined; };
      const r = await w.runner({ wallet: () => w.wallet }).run(PLAN);
      expect(r.kind).toBe(kind);
      expect(w.wallet.sent).toEqual([]);
    }
  });
  it("the pre-sign GET failing → its mapped stop, nothing signed", async () => {
    const w = world();
    let gets = 0;
    w.ov.getPlan = () => (++gets === 2 ? err(503, "UNAVAILABLE") : undefined);
    expect((await w.run()).kind).toBe("unavailable");
    expect(w.wallet.sent).toEqual([]);
  });
});

/* ══ Signing ═══════════════════════════════════════════════════════════════ */

describe("signing — one attempt, never retried", () => {
  it("EIP-1193 4001 → wallet_rejected after exactly one sendTransaction; no /tx, no journal, no re-quote", async () => {
    const w = world();
    w.wallet.sendQueue.push(() => Promise.reject(Object.assign(new Error("nope"), { code: 4001 })));
    const r = await w.run();
    expect(r).toMatchObject({ kind: "wallet_rejected", nodeId: "n1", txHash: null });
    expect(w.wallet.sent).toHaveLength(1);
    expect(w.counts.tx).toBe(0);
    expect(w.counts.quote).toBe(1);
    expect(w.log.some((l) => l.startsWith("journal:save"))).toBe(false);
  });
  it("a textual rejection (no code) → wallet_rejected; any other wallet error → wallet_error; both after one attempt", async () => {
    const a = world();
    a.wallet.sendQueue.push(() => Promise.reject(new Error("User rejected the request.")));
    expect((await a.run()).kind).toBe("wallet_rejected");
    expect(a.wallet.sent).toHaveLength(1);
    const b = world();
    b.wallet.sendQueue.push(() => Promise.reject(new Error("insufficient funds for gas")));
    expect((await b.run()).kind).toBe("wallet_error");
    expect(b.wallet.sent).toHaveLength(1);
  });
  it("isUserRejection: 4001, ACTION_REJECTED, nested cause, wording; not other errors", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ code: "ACTION_REJECTED" })).toBe(true);
    expect(isUserRejection({ message: "wrapped", cause: { code: 4001 } })).toBe(true);
    expect(isUserRejection(new Error("User denied transaction signature."))).toBe(true);
    expect(isUserRejection(new Error("execution reverted"))).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });

  it("approval then action: the approval is mined before the action is signed; only the ACTION hash reaches /tx", async () => {
    const w = world([{ nodeId: "n1", approve: true }]);
    const r = await w.run();
    expect(r.kind).toBe("completed");
    const i = (s: string) => w.log.indexOf(s);
    expect(i("sign:approve")).toBeLessThan(i(`receipt:${H(1)}`));
    expect(i(`receipt:${H(1)}`)).toBeLessThan(i("sign:action"));
    expect(w.seen.txs).toEqual([{ nodeId: "n1", quoteId: w.byId("n1").quoteId, txHash: H(2) }]);
    expect(w.log.some((l) => l.includes(`journal:save:${H(1)}`))).toBe(false);
    expect(w.seen.confirms).toEqual([expect.objectContaining({ txHash: H(2) })]);
  });
  it("approval reverted (or no explicit success status) → approval_failed; the action is never signed", async () => {
    for (const receipt of [{ status: "reverted" }, {}, { status: 0 }, null]) {
      const w = world([{ nodeId: "n1", approve: true }]);
      w.wallet.receiptFor.set(H(1), async () => receipt);
      const r = await w.run();
      expect(r).toMatchObject({ kind: "approval_failed", code: "APPROVAL_REVERTED", approvalTxHashes: [H(1)] });
      expect(signs(w)).toEqual(["sign:approve"]);
      expect(w.counts.tx).toBe(0);
    }
  });
  it("approval receipt timeout → approval_failed APPROVAL_TIMEOUT; never re-sent, action never signed", async () => {
    const w = world([{ nodeId: "n1", approve: true }]);
    w.wallet.receiptFor.set(H(1), async () => { throw new Error("timed out"); });
    expect(await w.run()).toMatchObject({ kind: "approval_failed", code: "APPROVAL_TIMEOUT" });
    expect(signs(w)).toEqual(["sign:approve"]);
  });
  it("approval rejected → wallet_rejected; action rejected after a mined approval → wallet_rejected carrying the approval hash", async () => {
    const a = world([{ nodeId: "n1", approve: true }]);
    a.wallet.sendQueue.push(() => Promise.reject({ code: 4001 }));
    expect((await a.run()).kind).toBe("wallet_rejected");
    expect(signs(a)).toEqual(["sign:approve"]);
    const b = world([{ nodeId: "n1", approve: true }]);
    b.wallet.sendQueue.push(async () => H(1), () => Promise.reject({ code: 4001 }));
    expect(await b.run()).toMatchObject({ kind: "wallet_rejected", approvalTxHashes: [H(1)] });
    expect(b.counts.tx).toBe(0);
  });
});

/* ══ Journal and /tx ═══════════════════════════════════════════════════════ */

describe("journal → /tx", () => {
  it("the final hash is journaled, THEN sent to /tx, THEN the receipt is awaited", async () => {
    const w = world();
    await w.run();
    const i = (s: string) => w.log.indexOf(s);
    expect(i(`journal:save:${H(1)}`)).toBeLessThan(i(`tx:n1:${H(1)}`));
    expect(i(`tx:n1:${H(1)}`)).toBeLessThan(i(`receipt:${H(1)}`));
  });
  it("/tx failing after broadcast → tx_unrecorded with full recovery info; journal kept; no rebroadcast, no confirm", async () => {
    for (const reply of [{ status: 502, body: { ok: false, code: "INTERNAL_ERROR" } }, { status: 0, body: null }, err(409, "CONFLICT")] as Reply[]) {
      const w = world();
      w.ov.tx = () => reply;
      const r = await w.run();
      expect(r).toMatchObject({ kind: "tx_unrecorded", nodeId: "n1", quoteId: w.byId("n1").quoteId, txHash: H(1), journaled: true, status: reply.status });
      expect(w.journal.entries.get("n1")).toEqual({ planId: PLAN, nodeId: "n1", quoteId: w.byId("n1").quoteId, txHash: H(1) });
      expect(w.wallet.sent).toHaveLength(1);
      expect(w.counts.confirm).toBe(0);
    }
  });
  it("journal write failing → tx_unrecorded (journaled:false) and /tx is NOT called", async () => {
    const w = world();
    w.journal.failSave = true;
    expect(await w.run()).toMatchObject({ kind: "tx_unrecorded", journaled: false, txHash: H(1) });
    expect(w.counts.tx).toBe(0);
    expect(w.wallet.sent).toHaveLength(1);
  });
  it("with the real localStorage journal: a malformed final hash is refused by save → tx_unrecorded (journaled:false), nothing stored, /tx NOT called", async () => {
    const w = world();
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const journal = createLocalJournal({ storage, wallet: WALLET, planId: PLAN });
    w.wallet.sendQueue.push(async () => "0xnot-a-hash");
    const r = await w.run({ journal });
    expect(r).toMatchObject({ kind: "tx_unrecorded", journaled: false, nodeId: "n1", txHash: "0xnot-a-hash" });
    expect(w.wallet.sent).toHaveLength(1);
    expect(w.counts.tx).toBe(0);
    expect(w.counts.confirm).toBe(0);
    expect(store.size).toBe(0);
  });
  it("with the real localStorage journal: a normal run journals, records, clears the key and completes", async () => {
    const w = world();
    const store = new Map<string, string>();
    const writes: string[] = [];
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(v); store.set(k, v); }, removeItem: (k: string) => void store.delete(k) };
    const r = await w.run({ journal: createLocalJournal({ storage, wallet: WALLET, planId: PLAN }) });
    expect(r.kind).toBe("completed");
    expect(writes).toEqual([JSON.stringify([{ planId: PLAN, nodeId: "n1", quoteId: w.byId("n1").quoteId, txHash: H(1) }])]);
    expect(w.seen.txs).toEqual([{ nodeId: "n1", quoteId: w.byId("n1").quoteId, txHash: H(1) }]);
    expect(store.size).toBe(0);
  });
  it("resume replays the journal into /tx — never signs again — then confirms and completes", async () => {
    const w = world();
    w.ov.tx = () => ({ status: 0, body: null });
    expect((await w.run()).kind).toBe("tx_unrecorded");
    delete w.ov.tx;
    const before = w.log.length;
    const r = await w.run();
    expect(r.kind).toBe("completed");
    const resumed = w.log.slice(before);
    expect(resumed.slice(0, 4)).toEqual(["grant", "journal:load", "getPlan", `tx:n1:${H(1)}`]);
    expect(resumed.filter((l) => l.startsWith("sign:") || l.startsWith("quote:") || l === "build")).toEqual([]);
    expect(w.wallet.sent).toHaveLength(1);
    expect(w.journal.entries.size).toBe(0);
  });
  it("journal replay failing again → tx_unrecorded again; still nothing signed", async () => {
    const w = world();
    w.journal.entries.set("n1", { planId: PLAN, nodeId: "n1", quoteId: QID(1), txHash: H(5) });
    w.byId("n1").quoteId = QID(1);
    w.ov.tx = () => err(503, "UNAVAILABLE");
    expect(await w.run()).toMatchObject({ kind: "tx_unrecorded", journaled: true, txHash: H(5) });
    expect(w.wallet.sent).toEqual([]);
    expect(w.journal.entries.size).toBe(1);
  });
  it("a journal entry already recorded is cleared; a DIFFERENT recorded hash is a conflict and the journal is kept", async () => {
    const a = world();
    Object.assign(a.byId("n1"), { quoteId: QID(1), quotes: 1, txHash: H(5) });
    a.journal.entries.set("n1", { planId: PLAN, nodeId: "n1", quoteId: QID(1), txHash: H(5) });
    expect((await a.run()).kind).toBe("completed");
    expect(a.journal.entries.size).toBe(0);
    expect(a.counts.tx).toBe(0);
    const b = world();
    Object.assign(b.byId("n1"), { quoteId: QID(1), quotes: 1, txHash: H(6) });
    b.journal.entries.set("n1", { planId: PLAN, nodeId: "n1", quoteId: QID(1), txHash: H(5) });
    expect((await b.run()).kind).toBe("conflict");
    expect(b.journal.entries.size).toBe(1);
    expect(b.wallet.sent).toEqual([]);
  });
  it("the journal can't be read → journal_unavailable; nothing quoted or signed", async () => {
    const w = world();
    w.journal.failLoad = true;
    expect((await w.run()).kind).toBe("journal_unavailable");
    expect(w.counts.quote).toBe(0);
    expect(w.wallet.sent).toEqual([]);
  });
});

/* ══ Receipt, confirm, settle ══════════════════════════════════════════════ */

describe("receipt and confirm", () => {
  it("a client-side receipt timeout still goes to confirm (and is never a reason to rebroadcast)", async () => {
    const w = world();
    w.wallet.receiptFor.set(H(1), async () => { throw new Error("timed out"); });
    expect((await w.run()).kind).toBe("completed");
    expect(w.counts.confirm).toBe(1);
    expect(w.wallet.sent).toHaveLength(1);
  });
  it("a reverted client receipt still goes to confirm, which decides (reverted)", async () => {
    const w = world();
    w.wallet.receiptFor.set(H(1), async () => ({ status: "reverted" }));
    w.outcomeOf.set("n1", "reverted");
    expect(await w.run()).toMatchObject({ kind: "reverted", txHash: H(1) });
    expect(w.counts.confirm).toBe(1);
  });
  it("confirm success / reverted / unverified are terminal: settle once, no sleeping", async () => {
    for (const [v, kind] of [["success", "completed"], ["reverted", "reverted"], ["unverified", "unverified"]] as const) {
      const w = world();
      w.outcomeOf.set("n1", v);
      expect((await w.run()).kind).toBe(kind);
      expect(w.counts.confirm).toBe(1);
      expect(w.counts.settle).toBe(1);
      expect(w.t.sleeps).toEqual([]);
    }
  });
  it("confirm 502, then a stored result → one poll cycle re-confirms and settles", async () => {
    const w = world();
    w.confirmScript.push({ status: 502, body: { ok: false, message: "Couldn't confirm that on-chain yet." } });
    expect((await w.run()).kind).toBe("completed");
    expect(w.counts.confirm).toBe(2);
    expect(w.t.sleeps).toEqual([5_000]);
    expect(w.wallet.sent).toHaveLength(1);
  });
  it("confirm network error, then a stored result → recovers the same way", async () => {
    const w = world();
    w.confirmScript.push("throw");
    expect((await w.run()).kind).toBe("completed");
    expect(w.counts.confirm).toBe(2);
    expect(w.t.sleeps).toEqual([5_000]);
  });
  it("confirm 409 (another confirm in flight): keeps re-confirming each cycle until settle sees the stored verdict", async () => {
    const w = world();
    let settles = 0;
    w.ov.confirm = () => ({ status: 409, body: { ok: false, message: "This confirmation is already being processed." } });
    w.ov.settle = () => { if (++settles === 3) w.verdicts.set(H(1), "success"); return undefined; };
    expect((await w.run()).kind).toBe("completed");
    expect(w.t.sleeps).toEqual([5_000, 10_000]);
    expect(w.counts.confirm).toBe(3);
    expect(w.wallet.sent).toHaveLength(1);
  });
  it("after a terminal confirm, polling only settles (no further confirms)", async () => {
    const w = world();
    let settles = 0;
    w.ov.settle = () => (++settles < 3 ? err(202, "SETTLEMENT_PENDING") : undefined);
    expect((await w.run()).kind).toBe("completed");
    expect(w.counts.confirm).toBe(1);
    expect(w.counts.settle).toBe(3);
  });
  it("confirm 400 (malformed request) is permanent → confirm_rejected; no polling", async () => {
    const w = world();
    w.ov.confirm = () => ({ status: 400, body: { ok: false, message: "A valid quoteId is required." } });
    expect(await w.run()).toMatchObject({ kind: "confirm_rejected", status: 400, txHash: H(1) });
    expect(w.t.sleeps).toEqual([]);
  });
  it("settle permanent errors stop (401 / 410); transient ones keep polling", async () => {
    const a = world();
    a.ov.settle = () => err(410, "EXPIRED");
    expect((await a.run()).kind).toBe("expired");
    const b = world();
    let n = 0;
    b.ov.settle = () => (++n === 1 ? { status: 0, body: null } : undefined);
    expect((await b.run()).kind).toBe("completed");
    expect(b.t.sleeps).toEqual([5_000]);
  });
});

describe("settlement polling — exact schedule, 10-minute cap by the clock", () => {
  it("confirm never stores a verdict: sleeps 5/10/20/40/60 then 60s; stops before passing 600,000 ms → stalled", async () => {
    const w = world();
    w.ov.confirm = () => ({ status: 502, body: { ok: false } });
    const r = await w.run();
    expect(r).toMatchObject({ kind: "stalled", nodeId: "n1", txHash: H(1), quoteId: w.byId("n1").quoteId });
    expect(w.t.sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(w.counts.settle).toBe(13);
    expect(w.counts.confirm).toBe(13);
    expect(w.t.now - T0).toBeLessThanOrEqual(SETTLE_POLL_CAP_MS);
  });
  it("stalled leaves the step submitted: no rebroadcast, no new quote, nothing journaled", async () => {
    const w = world();
    w.ov.confirm = () => ({ status: 502, body: { ok: false } });
    await w.run();
    expect(w.view().nodes[0].state).toBe("submitted");
    expect(w.wallet.sent).toHaveLength(1);
    expect(w.counts.quote).toBe(1);
    expect(w.journal.entries.size).toBe(0);
  });
  it("a slow confirm counts toward the cap: no new work starts once 600,000 ms have passed", async () => {
    const w = world();
    w.ov.confirm = () => { w.t.now += 90_000; return { status: 502, body: { ok: false } }; };
    const r = await w.run();
    expect(r.kind).toBe("stalled");
    // confirm at 0→90s; sleeps start at 90, 185, 285, 395, 525; the confirm
    // after the 60s sleep ends at 675s (> cap) so settle isn't called again.
    expect(w.t.sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    expect(w.counts.confirm).toBe(6);
    expect(w.counts.settle).toBe(5);
  });
  it("an abort signal during polling → aborted; the step stays submitted", async () => {
    const w = world();
    const ac = new AbortController();
    w.ov.confirm = () => ({ status: 502, body: { ok: false } });
    w.clock.sleep = async (ms) => { w.t.sleeps.push(ms); ac.abort(); throw new Error("aborted"); };
    const r = await w.runner().run(PLAN, { signal: ac.signal });
    expect(r).toMatchObject({ kind: "aborted", txHash: H(1) });
    expect(w.view().nodes[0].state).toBe("submitted");
  });
});

/* ══ Resume ════════════════════════════════════════════════════════════════ */

describe("resume", () => {
  it("a submitted step (txHash on the view) → confirm + settle with the view's quoteId and ref; no quote, build or signature", async () => {
    const w = world();
    Object.assign(w.byId("n1"), { quoteId: QID(7), quotes: 1, txHash: H(7) });
    expect((await w.run()).kind).toBe("completed");
    expect(w.seen.confirms).toEqual([{ ...REF, txHash: H(7), walletAddress: WALLET, quoteId: QID(7) }]);
    expect(w.counts.quote + w.counts.build + w.counts.tx).toBe(0);
    expect(w.wallet.sent).toEqual([]);
  });
  it("resume after a stall continues polling from a fresh cap", async () => {
    const w = world();
    w.ov.confirm = () => ({ status: 502, body: { ok: false } });
    expect((await w.run()).kind).toBe("stalled");
    delete w.ov.confirm;
    expect((await w.run()).kind).toBe("completed");
    expect(w.wallet.sent).toHaveLength(1);
  });
  it("an awaiting-signature step with no journal re-quotes (an old token is never assumed usable)", async () => {
    const w = world();
    Object.assign(w.byId("n1"), { quoteId: QID(3), quotes: 1 });
    expect((await w.run()).kind).toBe("completed");
    expect(w.byId("n1").quotes).toBe(2);
    expect(w.seen.builds).toEqual([expect.objectContaining({ quoteToken: `tok-${w.byId("n1").quoteId}` })]);
  });
});

/* ══ Same-instance guard, abort, configuration ═════════════════════════════ */

describe("same-instance guard and configuration", () => {
  it("a second run() on the same instance while one is in flight → already_running (no calls)", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realSettle = w.plans.settle;
    w.plans.settle = async (p, n) => { await gate; return realSettle(p, n); };
    const runner = w.runner();
    const first = runner.run(PLAN);
    await vi.waitFor(() => expect(w.log).toContain(`confirm:${H(1)}`));
    expect(runner.running).toBe(true);
    const calls = w.log.length;
    expect((await runner.run(PLAN)).kind).toBe("already_running");
    expect(w.log.length).toBe(calls);
    release();
    expect((await first).kind).toBe("completed");
    expect(runner.running).toBe(false);
  });
  it("an abort before start → aborted, nothing called", async () => {
    const w = world();
    const ac = new AbortController();
    ac.abort();
    expect((await w.runner().run(PLAN, { signal: ac.signal })).kind).toBe("aborted");
    expect(w.log).toEqual([]);
  });
  it("a TxJournal is REQUIRED: missing or incomplete journal throws PlanRunnerConfigError", () => {
    const w = world();
    expect(() => createPlanRunner({ ...w.deps(), journal: undefined as never })).toThrow(PlanRunnerConfigError);
    expect(() => createPlanRunner({ ...w.deps(), journal: { save() {}, load: () => [] } as never })).toThrow(/journal/);
    expect(() => createPlanRunner({ ...w.deps(), chainId: 0 })).toThrow(PlanRunnerConfigError);
    expect(() => createPlanRunner({ ...w.deps(), sdk: { build: w.sdk.build } as never })).toThrow(PlanRunnerConfigError);
    expect(() => createPlanRunner(w.deps())).not.toThrow();
  });
});

/* ══ HTTP adapter (the only request-making code) ═══════════════════════════ */

describe("HTTP transport adapter", () => {
  function fakeHttp(reply: (url: string, init: Parameters<HttpFn>[1]) => { status: number; text: string } | Error) {
    const calls: { url: string; init: Parameters<HttpFn>[1] }[] = [];
    const http: HttpFn = async (url, init) => {
      calls.push({ url, init });
      const r = reply(url, init);
      if (r instanceof Error) throw r;
      return { status: r.status, text: async () => r.text };
    };
    return { http, calls };
  }
  it("maps every port to the existing routes: same-origin, no-store, exact bodies; no approve/abandon", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, text: "{\"ok\":true}" }));
    const t = createHttpTransports({ http, baseUrl: "https://app.example" });
    expect(Object.keys(t.plans).sort()).toEqual(["bind", "getPlan", "next", "quote", "settle", "tx"]);
    await t.plans.getPlan("plan_x/y");
    await t.plans.next("p");
    await t.plans.quote("p", "n1");
    await t.plans.bind("p", "n1", "tok");
    await t.plans.tx("p", "n1", { quoteId: "q", txHash: "h" });
    await t.plans.settle("p", "n1");
    await t.sdk.build({ ...REF, inputs: { a: "1" }, walletAddress: WALLET, quoteToken: "tok" });
    await t.sdk.confirm({ ...REF, txHash: "h", walletAddress: WALLET, quoteId: "q" });
    expect(calls.map((c) => `${c.init.method} ${c.url} ${c.init.body ?? ""}`)).toEqual([
      "GET https://app.example/api/plans/plan_x%2Fy ",
      "POST https://app.example/api/plans/p {\"op\":\"next\"}",
      "POST https://app.example/api/plans/p {\"op\":\"quote\",\"nodeId\":\"n1\"}",
      "POST https://app.example/api/plans/p {\"op\":\"bind\",\"nodeId\":\"n1\",\"quoteToken\":\"tok\"}",
      "POST https://app.example/api/plans/p {\"op\":\"tx\",\"nodeId\":\"n1\",\"quoteId\":\"q\",\"txHash\":\"h\"}",
      "POST https://app.example/api/plans/p {\"op\":\"settle\",\"nodeId\":\"n1\"}",
      `POST https://app.example/api/ask/action/build {"protocolId":"payai","actionId":"transfer","version":"1.0.0","inputs":{"a":"1"},"walletAddress":"${WALLET}","quoteToken":"tok"}`,
      `POST https://app.example/api/ask/action/confirm {"protocolId":"payai","actionId":"transfer","version":"1.0.0","txHash":"h","walletAddress":"${WALLET}","quoteId":"q"}`,
    ]);
    for (const c of calls) expect(c.init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });
  it("network failure → status 0; non-JSON → body null; status is passed through (202, 409, 200+ok:false)", async () => {
    const t1 = createHttpTransports({ http: fakeHttp(() => new Error("Failed to fetch")).http });
    expect(await t1.plans.settle("p", "n1")).toEqual({ status: 0, body: null });
    const t2 = createHttpTransports({ http: fakeHttp(() => ({ status: 502, text: "<html>bad gateway</html>" })).http });
    expect(await t2.sdk.confirm({ ...REF, txHash: "h", walletAddress: WALLET, quoteId: "q" })).toEqual({ status: 502, body: null });
    const t3 = createHttpTransports({ http: fakeHttp(() => ({ status: 202, text: "{\"ok\":false,\"code\":\"SETTLEMENT_PENDING\"}" })).http });
    expect(await t3.plans.settle("p", "n1")).toEqual({ status: 202, body: { ok: false, code: "SETTLEMENT_PENDING" } });
  });
  it("grant source reads GET /api/auth/wallet-grant (lowercased address, null without one; throws offline)", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, text: JSON.stringify({ address: WALLET.toUpperCase().replace("0X", "0x") }) }));
    expect(await createHttpTransports({ http }).grant.currentAddress()).toBe(WALLET);
    expect(calls[0]).toMatchObject({ url: "/api/auth/wallet-grant", init: { method: "GET" } });
    expect(await createHttpTransports({ http: fakeHttp(() => ({ status: 200, text: "{\"address\":null}" })).http }).grant.currentAddress()).toBeNull();
    await expect(createHttpTransports({ http: fakeHttp(() => new Error("offline")).http }).grant.currentAddress()).rejects.toThrow();
  });
});

/* ══ Source boundary / security guards ═════════════════════════════════════ */

describe("source boundary", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "plans-client", "runner.ts"), "utf8");
  const MARKER = "/* ══ HTTP transport adapter";
  const [orchestration, adapter] = [src.slice(0, src.indexOf(MARKER)), src.slice(src.indexOf(MARKER))];

  it("has no imports at all (browser-safe; no server DTOs or modules)", () => {
    expect(src.indexOf(MARKER)).toBeGreaterThan(0);
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(|import\(/);
  });
  it("no keys, server signers, environment, server-only or Node APIs, or custodial / out-of-scope systems", () => {
    for (const word of ["MONAD_AGENT_PRIVATE_KEY", "privateKeyToAccount", "createWalletClient", "process.env", "server-only", "getPublicClient", "localStorage", "mnemonic", "seed phrase"]) {
      expect(src.includes(word), `runner must not reference ${word}`).toBe(false);
    }
    expect(src).not.toMatch(/["']node:/);
    for (const word of ["telegram", "automation", "rooms", "cron"]) expect(src.toLowerCase().includes(word), `runner must not reference ${word}`).toBe(false);
  });
  it("orchestration makes no requests; only the isolated adapter does", () => {
    expect(orchestration).not.toMatch(/\bfetch\b/);
    expect(orchestration.includes("httpImpl")).toBe(false);
    expect(adapter).toMatch(/globalThis\.fetch\(/);
  });
  it("the only signing primitive is the injected wallet's sendTransaction", () => {
    const calls = src.match(/sendTransaction\(/g) ?? [];
    const viaSigner = src.match(/signer\.sendTransaction\(/g) ?? [];
    expect(viaSigner.length).toBe(2); // approvals, final action
    expect(calls.length).toBe(viaSigner.length + 1); // + the port's declaration
    for (const word of ["signMessage", "signTransaction", "signTypedData", "eth_send", "personal_sign", ".request("]) {
      expect(src.includes(word), `runner must not reference ${word}`).toBe(false);
    }
  });
  it("never approves or abandons a plan; the adapter only sends the step ops", () => {
    expect(src).not.toMatch(/approvePlan|abandonPlan|["']abandon["']|op:\s*["']approve["']/);
    const ops = [...src.matchAll(/op:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(new Set(ops)).toEqual(new Set(["next", "quote", "bind", "tx", "settle"]));
  });
  it("lives outside lib/plan (the Phase 2A guard's directory is untouched)", () => {
    expect(join("lib", "plans-client", "runner.ts").startsWith(join("lib", "plan") + "/")).toBe(false);
  });
});

/* ══ Type compatibility ════════════════════════════════════════════════════ */

describe("type compatibility (compile-time)", () => {
  it("WalletServiceState is a RunnerWallet; the server's views fit the runner's DTOs", () => {
    expectTypeOf<WalletServiceState>().toExtend<RunnerWallet>();
    expectTypeOf<PlanView>().toExtend<PlanViewDTO>();
    expectTypeOf<NextStep>().toExtend<NextStepDTO>();
    expectTypeOf<StepQuote>().toExtend<StepQuoteDTO>();
    expectTypeOf<BoundQuote>().toExtend<BoundQuoteDTO>();
    expectTypeOf<UnsignedActionStep>().toExtend<BuildStepDTO>();
    expect(true).toBe(true);
  });
});

/* ══ Review follow-up F1: re-check before the FINAL signature ══════════════ */

describe("F1 — after approvals, the final action is re-checked before it is signed", () => {
  /** A one-step world with an approval; `during` runs while the approval is
   *  being mined (i.e. after it was signed, before the final signature). */
  function approvalWorld(during: (w: World) => void) {
    const w = world([{ nodeId: "n1", approve: true }]);
    w.wallet.receiptFor.set(H(1), async () => { during(w); return { status: "success" }; });
    return w;
  }
  /** Zero FINAL sendTransaction calls: only the approval was ever signed. */
  const noFinal = (w: World) => {
    expect(signs(w)).toEqual(["sign:approve"]);
    expect(w.wallet.sent).toHaveLength(1);
    expect(w.counts.tx).toBe(0);
    expect(w.log.some((l) => l.startsWith("journal:save"))).toBe(false);
  };

  it("the re-check happens between the approval receipt and the final signature: plan GET, then grant", async () => {
    const w = approvalWorld(() => {});
    expect((await w.run()).kind).toBe("completed");
    const between = w.log.slice(w.log.indexOf(`receipt:${H(1)}`) + 1, w.log.indexOf("sign:action"));
    expect(between).toEqual(["getPlan", "grant"]);
  });
  it("without approvals there is exactly one pre-sign check (unchanged)", async () => {
    const w = world();
    await w.run();
    const before = w.log.slice(w.log.indexOf("build") + 1, w.log.indexOf("sign:action"));
    expect(before).toEqual(["getPlan", "grant"]);
  });

  const cases: [string, (w: World) => void, Partial<{ kind: string; code: string }>][] = [
    ["network switched", (w) => { w.wallet.chainId = 1; }, { kind: "wrong_network" }],
    ["isWrongNetwork set", (w) => { w.wallet.isWrongNetwork = true; }, { kind: "wrong_network" }],
    ["account switched (grant unchanged)", (w) => { w.wallet.address = OTHER; }, { kind: "wallet_mismatch" }],
    ["grant and account both switched", (w) => { w.grant.address = OTHER; w.wallet.address = OTHER; }, { kind: "wallet_mismatch" }],
    ["grant gone", (w) => { w.grant.address = null; }, { kind: "grant_required" }],
    ["wallet locked", (w) => { w.wallet.address = null; }, { kind: "wallet_locked" }],
    ["quote superseded", (w) => { w.byId("n1").quoteId = QID(600); }, { kind: "conflict", code: "QUOTE_SUPERSEDED" }],
    ["a txHash appeared", (w) => { w.byId("n1").txHash = H(600); }, { kind: "conflict", code: "TX_ALREADY_RECORDED" }],
    ["plan abandoned", (w) => { w.flags.abandoned = true; }, { kind: "abandoned" }],
    ["plan no longer approved", (w) => { w.flags.approved = false; }, { kind: "not_approved" }],
  ];
  for (const [name, mutate, expected] of cases) {
    it(`${name} during the approval → ${expected.kind}; the final action is never signed`, async () => {
      const w = approvalWorld(mutate);
      const r = await w.runner({ wallet: () => w.wallet }).run(PLAN);
      expect(r).toMatchObject({ ...expected, nodeId: "n1", approvalTxHashes: [H(1)] });
      noFinal(w);
      expect(w.counts.quote).toBe(1); // never re-quoted
    });
  }

  it("plan expired during the approval → expired; no final signature", async () => {
    const w = approvalWorld(() => {
      w.ov.getPlan = () => ok({ plan: { ...w.view(), expired: true } });
    });
    expect((await w.run()).kind).toBe("expired");
    noFinal(w);
  });
  it("the node is no longer the current awaiting-signature step → step_not_ready; no final signature", async () => {
    for (const patch of [{ currentStep: "n9" }, { stateOf: "pending" as NodeStateDTO }]) {
      const w = approvalWorld(() => {
        w.ov.getPlan = () => {
          const v = w.view();
          return ok({ plan: "currentStep" in patch ? { ...v, currentStep: patch.currentStep } : { ...v, nodes: v.nodes.map((n) => ({ ...n, state: patch.stateOf })) } });
        };
      });
      expect((await w.run()).kind).toBe("step_not_ready");
      noFinal(w);
    }
  });
  it("the plan GET failing during the re-check → its stop; no final signature", async () => {
    const w = approvalWorld(() => { w.ov.getPlan = () => err(503, "UNAVAILABLE"); });
    expect((await w.run()).kind).toBe("unavailable");
    noFinal(w);
  });
  it("an abort during the approval → aborted before the final signature", async () => {
    const ac = new AbortController();
    const w = approvalWorld(() => ac.abort());
    expect((await w.runner().run(PLAN, { signal: ac.signal })).kind).toBe("aborted");
    noFinal(w);
  });
  it("the final action is signed by the wallet AS IT IS NOW (getter re-read), never the pre-approval snapshot", async () => {
    const w = world([{ nodeId: "n1", approve: true }]);
    const usedBy: string[] = [];
    const as = (name: string): RunnerWallet => ({
      address: WALLET, chainId: CHAIN, isWrongNetwork: false,
      sendTransaction: (tx) => { usedBy.push(name); return w.wallet.sendTransaction(tx); },
      waitForReceipt: (h) => w.wallet.waitForReceipt(h),
    });
    let current = as("before");
    w.wallet.receiptFor.set(H(1), async () => { current = as("after"); return { status: "success" }; });
    expect((await w.runner({ wallet: () => current }).run(PLAN)).kind).toBe("completed");
    expect(usedBy).toEqual(["before", "after"]);
  });
});

/* ══ Review follow-up F2: journal corruption is never skipped ══════════════ */

describe("F2 — a journal that can't be read with certainty stops the run", () => {
  const VALID = { planId: PLAN, nodeId: "n1", quoteId: QID(1), txHash: H(5) };
  const FOREIGN = { planId: `plan_${"b".repeat(32)}`, nodeId: "n1", quoteId: QID(2), txHash: H(6) };
  const withLoad = (w: World, load: () => unknown) => w.runner({ journal: { save: w.journal.save, clear: w.journal.clear, load: load as never } });
  /** Nothing was quoted, built, signed or recorded. */
  const untouched = (w: World) => {
    expect(w.counts.quote + w.counts.build + w.counts.tx).toBe(0);
    expect(w.wallet.sent).toEqual([]);
  };

  it("load() not returning an array → journal_unavailable, before any plan call", async () => {
    for (const loaded of [null, undefined, {}, "[]", { 0: VALID, length: 1 }]) {
      const w = world();
      expect((await withLoad(w, async () => loaded).run(PLAN)).kind).toBe("journal_unavailable");
      untouched(w);
      expect(w.counts.getPlan).toBe(0);
    }
  });
  it("a malformed current-plan entry → journal_unavailable (no coercion, no repair)", async () => {
    const bad: unknown[] = [
      null, "entry", [VALID],
      { ...VALID, txHash: undefined }, { ...VALID, txHash: "0x1234" }, { ...VALID, txHash: 5 },
      { ...VALID, quoteId: "" }, { ...VALID, quoteId: "ABCDEF0123456789ABCDEF0123456789" }, { ...VALID, quoteId: 7 },
      { ...VALID, nodeId: "" }, { ...VALID, nodeId: 1 }, { nodeId: "n1", quoteId: QID(1), txHash: H(5) },
      { ...VALID, planId: "" }, { ...VALID, planId: 1 },
    ];
    for (const entry of bad) {
      const w = world();
      expect((await withLoad(w, async () => [entry]).run(PLAN)).kind, JSON.stringify(entry)).toBe("journal_unavailable");
      untouched(w);
    }
  });
  it("a malformed entry is never silently skipped — not even next to a valid one, or for a foreign planId", async () => {
    for (const loaded of [[VALID, { ...VALID, txHash: "bad" }], [{ ...FOREIGN, txHash: "bad" }], [FOREIGN, { planId: PLAN }]]) {
      const w = world();
      w.byId("n1").quoteId = QID(1);
      expect((await withLoad(w, async () => loaded).run(PLAN)).kind).toBe("journal_unavailable");
      untouched(w);
    }
  });
  it("a well-formed entry for another plan is ignored; the run proceeds normally", async () => {
    const w = world();
    const r = await withLoad(w, async () => [FOREIGN]).run(PLAN);
    expect(r.kind).toBe("completed");
    expect(w.seen.txs.map((t) => t.txHash)).toEqual([H(1)]); // its own new hash, not the foreign one
  });
  it("a well-formed current-plan entry is replayed through /tx without signing", async () => {
    const w = world();
    w.byId("n1").quoteId = QID(1);
    w.journal.entries.set("n1", { ...VALID });
    expect((await w.run()).kind).toBe("completed");
    expect(w.seen.txs).toEqual([{ nodeId: "n1", quoteId: QID(1), txHash: H(5) }]);
    expect(w.wallet.sent).toEqual([]);
    expect(w.counts.quote + w.counts.build).toBe(0);
    expect(w.journal.entries.size).toBe(0);
  });
  it("the entry is preserved when the replayed /tx fails (any status) — never signed or rebroadcast", async () => {
    for (const reply of [err(404, "NOT_FOUND"), err(400, "INVALID_PLAN"), err(401, "wallet_grant_required"), { status: 0, body: null }] as Reply[]) {
      const w = world();
      w.byId("n1").quoteId = QID(1);
      w.journal.entries.set("n1", { ...VALID });
      w.ov.tx = () => reply;
      expect(await w.run()).toMatchObject({ kind: "tx_unrecorded", journaled: true, txHash: H(5) });
      expect(w.journal.entries.get("n1")).toEqual(VALID);
      expect(w.wallet.sent).toEqual([]);
      expect(w.counts.quote + w.counts.build).toBe(0);
    }
  });
  it("two valid entries for the same step → the second is a conflict; nothing signed", async () => {
    const w = world();
    w.byId("n1").quoteId = QID(1);
    const second = { ...VALID, txHash: H(8) };
    const r = await withLoad(w, async () => [VALID, second]).run(PLAN);
    expect(r).toMatchObject({ kind: "conflict", txHash: H(8) });
    expect(w.seen.txs).toEqual([{ nodeId: "n1", quoteId: QID(1), txHash: H(5) }]);
    expect(w.wallet.sent).toEqual([]);
  });
  it("journalEntriesFor: exact narrowing, no coercion", () => {
    expect(journalEntriesFor(PLAN, [])).toEqual([]);
    expect(journalEntriesFor(PLAN, [VALID, FOREIGN])).toEqual([VALID]);
    expect(journalEntriesFor(PLAN, [{ ...VALID, extra: 1 }])).toEqual([VALID]);
    expect(journalEntriesFor(PLAN, [{ ...VALID, txHash: ` ${H(5)}` }])).toBeNull();
    expect(journalEntriesFor(PLAN, "x")).toBeNull();
  });
});

/* ══ Integration: the runner against the REAL routes ═══════════════════════ */

// Only the chain (RPC) and the payment policy are stubbed; everything else —
// plan routes, wallet grant, quote tokens, build gates (Layer A/B, one build
// per quote), confirm (build match, verdict, confirmed outputs), plan
// settlement — is the real code.
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

describe("integration: real Plan API, wallet grant, build and confirm routes", () => {
  const BASE = "https://app.usepayai.xyz";
  const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
  const OUT = "100000000";
  const AMOUNT_IN = "2000000000000000000";
  const RECIPIENT = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
  const APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
  const units = (value: string) => ({ verified: true as const, type: "units" as const, value, token: TOKEN });
  let buildSeq = 0;

  function adapter(protocolId: string, action: Partial<Action> & Pick<Action, "actionId" | "inputSchema">): ProtocolAdapter {
    return {
      protocolId, name: `${protocolId} (runner fixture)`, chainId: 143, allowedTargets: [TARGET],
      actions: [{
        version: "1.0.0", name: action.actionId, description: "runner fixture", protocolId, chainId: 143, allowedTargets: [TARGET],
        async quote() { return { summary: `${action.actionId} quote`, details: {}, quotedAt: Date.now(), terms: { kind: action.actionId } }; },
        async parseResult() { return {}; },
        async outflows() { return []; },
        ...action,
      } as Action],
    };
  }
  /** A swap that needs an ERC-20 approval first, and reports a verified amountOut. */
  const SWAPX = adapter("rtest-swap", {
    actionId: "swap",
    inputSchema: {
      tokenIn: { type: "token", required: false, description: "in" },
      tokenOut: { type: "token", required: true, description: "out" },
      amountIn: { type: "units", required: true, description: "amount in" },
    },
    outputs: {
      amountOut: { type: "units", description: "out", denominatedIn: { input: "tokenOut" } },
      tokenOut: { type: "token", description: "token", denominatedIn: { input: "tokenOut" } },
    },
    async build(inputs: ActionInputs) {
      const tokenIn = String(inputs.tokenIn) as `0x${string}`;
      const amount = String(inputs.amountIn);
      return [
        { kind: "approve", label: "Approve", tx: { to: tokenIn, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [TARGET, BigInt(amount)] }), value: "0" }, approval: { token: tokenIn, spender: TARGET, amount } },
        { kind: "action", label: "Swap", tx: { to: TARGET, data: `0x5a${(++buildSeq).toString(16).padStart(8, "0")}`, value: "0" } },
      ] as UnsignedActionStep[];
    },
    async confirmedOutputs() {
      return { outputs: { amountOut: units(OUT), tokenOut: { verified: true as const, type: "token" as const, value: TOKEN } }, denominations: { tokenOut: TOKEN } };
    },
  });
  /** A transfer that consumes the swap's amountOut and reports what it sent. */
  const SENDX = adapter("rtest-send", {
    actionId: "transfer",
    inputSchema: {
      recipient: { type: "address", required: true, description: "to" },
      token: { type: "token", required: false, description: "token" },
      amount: { type: "units", required: true, description: "amount" },
    },
    outputs: { amount: { type: "units", description: "sent", denominatedIn: { input: "token" } } },
    async build() {
      return [{ kind: "action", label: "Send", tx: { to: TARGET, data: `0x5e${(++buildSeq).toString(16).padStart(8, "0")}`, value: "0" } }] as UnsignedActionStep[];
    },
    async confirmedOutputs() { return { outputs: { amount: units(OUT) }, denominations: { token: TOKEN } }; },
  });

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
    registerProtocol(SWAPX);
    registerProtocol(SENDX);
  });
  afterEach(() => {
    if (savedNetwork === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = savedNetwork;
    vi.useRealTimers();
  });

  /** Same-origin requests straight into the real route handlers, carrying
   *  the browser's HttpOnly grant cookie (which the runner never sees). */
  async function routeHttp(): Promise<HttpFn> {
    const { encodeWalletGrant, WALLET_GRANT_COOKIE } = await import("@/lib/auth/walletGrant");
    const cookie = `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(WALLET, Date.now() + 3_600_000)}`;
    return async (url, init) => {
      const u = new URL(url, BASE);
      const req = new NextRequest(u, { method: init.method, headers: { ...init.headers, cookie, "x-real-ip": "203.0.113.9" }, ...(init.body ? { body: init.body } : {}) });
      let res: Response;
      if (u.pathname === "/api/auth/wallet-grant") res = await (await import("@/app/api/auth/wallet-grant/route")).GET(req);
      else if (u.pathname === "/api/ask/action/build") res = await (await import("@/app/api/ask/action/build/route")).POST(req);
      else if (u.pathname === "/api/ask/action/confirm") res = await (await import("@/app/api/ask/action/confirm/route")).POST(req);
      else if (u.pathname.startsWith("/api/plans/")) {
        const planId = decodeURIComponent(u.pathname.slice("/api/plans/".length));
        const mod = await import("@/app/api/plans/[planId]/route");
        const ctx = { params: Promise.resolve({ planId }) };
        res = init.method === "GET" ? await mod.GET(req, ctx) : await mod.POST(req, ctx);
      } else if (u.pathname === "/api/plans") res = await (await import("@/app/api/plans/route")).POST(req);
      else throw new Error(`unrouted ${u.pathname}`);
      return { status: res.status, text: () => res.text() };
    };
  }

  it("swap (approve + action) → dependent transfer: inputs, token, wallet and quoteId flow through the real build; only final hashes reach the plan; confirm gets the same quoteId/txHash", async () => {
    const http = await routeHttp();
    const ref = (p: string, a: string) => ({ protocolId: p, actionId: a, version: "1.0.0" });
    const node = (nodeId: string, r: object, inputs: object, dependsOn: string[] = []) => ({ nodeId, ref: r, inputs, dependsOn, validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" } });
    const draft = {
      id: "intent_runner_0001", version: 1, chainId: 143, wallet: WALLET, status: "draft",
      source: { text: `swap 2 WMON to USDC and send it to ${RECIPIENT}`, adapter: "deterministic", adapterVersion: "1" },
      nodes: [
        node("n1", ref("rtest-swap", "swap"), { tokenIn: { kind: "literal", value: WMON }, tokenOut: { kind: "literal", value: TOKEN }, amountIn: { kind: "literal", value: AMOUNT_IN } }),
        node("n2", ref("rtest-send", "transfer"), { recipient: { kind: "recipient", display: RECIPIENT, source: "address", address: RECIPIENT }, token: { kind: "literal", value: TOKEN }, amount: { kind: "output", node: "n1", output: "amountOut" } }, ["n1"]),
      ],
    };
    // The plan is created and APPROVED by the user — the runner never approves.
    // Its fixture actions are test-only (not reviewable under Stage 5B), so the
    // approval here is set up through the store; approval itself is tested
    // with reviewable plans in plan-service / plan-api / plan-review tests.
    const created = await http(`${BASE}/api/plans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draft }), credentials: "same-origin", cache: "no-store" });
    expect(created.status).toBe(200);
    const planId = JSON.parse(await created.text()).plan.planId as string;
    const store = await import("@/lib/plan/store");
    await store.approvePlan(planId, { sessionWallet: WALLET, activeChainId: 143 });

    // Spy on what crosses each port.
    const t = createHttpTransports({ http, baseUrl: BASE });
    const seen = { quotes: [] as StepQuoteDTO[], builds: [] as { req: unknown; body: { quoteId?: string; steps?: unknown[] } }[], txs: [] as { nodeId: string; quoteId: string; txHash: string }[], confirms: [] as { quoteId: string; txHash: string; walletAddress: string }[] };
    const plans: PlanTransport = {
      ...t.plans,
      quote: async (p, n) => { const r = await t.plans.quote(p, n); seen.quotes.push((r.body as { quote: StepQuoteDTO }).quote); return r; },
      tx: async (p, n, input) => { seen.txs.push({ nodeId: n, ...input }); return t.plans.tx(p, n, input); },
    };
    const sdk: SdkTransport = {
      build: async (req) => { const r = await t.sdk.build(req); seen.builds.push({ req, body: r.body as never }); return r; },
      confirm: async (req) => { seen.confirms.push(req); return t.sdk.confirm(req); },
    };
    // The user's wallet: "broadcasts" by putting the exact signed tx on the stubbed chain.
    let h = 0;
    const sent: { to: string; data?: string; value?: string; hash: string }[] = [];
    const wallet: RunnerWallet = {
      address: WALLET, chainId: 143, isWrongNetwork: false,
      async sendTransaction(tx) {
        const hash = H(0xbeef00 + ++h);
        chain.txs.set(hash, { from: WALLET, to: tx.to, input: tx.data ?? "0x", value: BigInt(tx.value ?? "0") });
        sent.push({ ...tx, hash });
        return hash;
      },
      async waitForReceipt() { return { status: "success" }; },
    };
    const journal = new Map<string, JournalEntry>();
    const clock: Clock = { now: () => Date.now(), async sleep(ms) { vi.setSystemTime(Date.now() + ms); } };

    const runner = createPlanRunner({
      wallet, plans, sdk, grant: t.grant, clock, chainId: 143, lock: fakeLock(),
      journal: { save: (e) => void journal.set(e.nodeId, e), load: () => [...journal.values()], clear: (_p, n) => void journal.delete(n) },
    });
    const r = await runner.run(planId);
    expect(r.kind).toBe("completed");

    // Quote → build: same ref, the quote's exact inputs and token, the grant wallet; same quoteId back.
    expect(seen.quotes.map((q) => q.nodeId)).toEqual(["n1", "n2"]);
    seen.quotes.forEach((q, i) => {
      expect(seen.builds[i].req).toEqual({ ...q.ref, inputs: q.inputs, walletAddress: WALLET, quoteToken: q.quoteToken });
      expect(seen.builds[i].body.quoteId).toBe(q.quoteId);
    });
    // n2's amount is n1's VERIFIED output, resolved server-side.
    expect(seen.quotes[1].inputs.amount).toBe(OUT);

    // Three signatures (approval, swap, transfer); only the two final-action hashes reach the plan.
    expect(sent.map((s) => s.to.toLowerCase())).toEqual([WMON, TARGET, TARGET]);
    expect(seen.txs).toEqual([
      { nodeId: "n1", quoteId: seen.quotes[0].quoteId, txHash: sent[1].hash },
      { nodeId: "n2", quoteId: seen.quotes[1].quoteId, txHash: sent[2].hash },
    ]);
    expect(seen.txs.some((x) => x.txHash === sent[0].hash)).toBe(false);
    expect(seen.confirms).toEqual([
      { protocolId: "rtest-swap", actionId: "swap", version: "1.0.0", txHash: sent[1].hash, walletAddress: WALLET, quoteId: seen.quotes[0].quoteId },
      { protocolId: "rtest-send", actionId: "transfer", version: "1.0.0", txHash: sent[2].hash, walletAddress: WALLET, quoteId: seen.quotes[1].quoteId },
    ]);

    // The real plan agrees.
    const view = r.plan!;
    expect(view.state).toBe("completed");
    expect(view.nodes.map((n) => [n.nodeId, n.state, n.txHash, n.quoteId])).toEqual([
      ["n1", "confirmed", sent[1].hash, seen.quotes[0].quoteId],
      ["n2", "confirmed", sent[2].hash, seen.quotes[1].quoteId],
    ]);
    expect(journal.size).toBe(0);
  });
});


/* ══ Stage 5C-1: the quote review port and progress events ═════════════════ */

describe("5C-1 — confirmQuote: an explicit review boundary before anything is built", () => {
  /** A reviewer that records what it saw and answers `answer`. */
  function reviewer(w: World, answer: (q: QuoteProjection) => Promise<QuoteDecision> | QuoteDecision = () => "continue") {
    const seen: QuoteProjection[] = [];
    const confirmQuote = async (q: QuoteProjection) => { w.log.push("review"); seen.push(q); return answer(q); };
    return { seen, confirmQuote };
  }
  const tokenFree = (v: unknown) => {
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/tok-/);
    expect(json).not.toMatch(/quoteToken|quoteTokenHash|termsHash|inputsHash|graphHash/);
  };

  it("runs after quote + bind and before build; the binding is re-checked by the server after the review", async () => {
    const w = world();
    const { confirmQuote } = reviewer(w);
    const r = await w.runner({ confirmQuote }).run(PLAN);
    expect(r.kind).toBe("completed");
    const i = (s: string) => w.log.indexOf(s);
    expect(w.log.slice(i("quote:n1"), i("build") + 1)).toEqual(["quote:n1", "bind:n1", "review", "bind:n1", "build"]);
    expect(i("review")).toBeLessThan(i("sign:action"));
  });

  it("receives the server's projection — summary, details, freshness, risk/warnings — and never the quote token", async () => {
    const w = world();
    w.ov.quote = () => {
      const n = w.byId("n1");
      n.quotes++; n.quoteId = QID(41); n.quotedAt = w.t.now;
      return ok({ quote: { nodeId: "n1", ref: REF, attempt: n.quotes, quoteId: n.quoteId, quoteToken: `tok-${n.quoteId}`, inputs: { amount: "100" },
        summary: "Send 1 USDC (they receive 0.9975 USDC)", details: { "you send": "1 USDC", "platform fee": "0.0025 USDC", "recipient receives": "0.9975 USDC" },
        quotedAt: w.t.now, risk: { score: 5, level: "low", compliance: "approved" }, warnings: ["first payment to this address"] } });
    };
    const { seen, confirmQuote } = reviewer(w);
    expect((await w.runner({ confirmQuote }).run(PLAN)).kind).toBe("completed");
    expect(seen).toEqual([{
      nodeId: "n1", ref: REF, attempt: 1, quoteId: QID(41),
      summary: "Send 1 USDC (they receive 0.9975 USDC)", details: { "you send": "1 USDC", "platform fee": "0.0025 USDC", "recipient receives": "0.9975 USDC" },
      quotedAt: T0, freshUntil: T0 + 90_000, risk: { score: 5, level: "low", compliance: "approved" }, warnings: ["first payment to this address"],
    }]);
    tokenFree(seen);
  });

  it("malformed risk / warnings from the server are dropped, not passed on", async () => {
    const w = world();
    const real = w.plans.quote;
    w.plans.quote = async (p, n) => {
      const r = await real(p, n);
      Object.assign((r.body as { quote: Record<string, unknown> }).quote, { risk: { score: "high" }, warnings: ["ok", 5] });
      return r;
    };
    const { seen, confirmQuote } = reviewer(w);
    await w.runner({ confirmQuote }).run(PLAN);
    expect(seen[0]).not.toHaveProperty("risk");
    expect(seen[0]).not.toHaveProperty("warnings");
  });

  it("continue → the existing execution proceeds unchanged (one signature, /tx, confirm, settle)", async () => {
    const w = world([{ nodeId: "n1", approve: true }]);
    const { confirmQuote } = reviewer(w);
    expect((await w.runner({ confirmQuote }).run(PLAN)).kind).toBe("completed");
    expect(signs(w)).toEqual(["sign:approve", "sign:action"]);
    expect(w.seen.txs).toEqual([{ nodeId: "n1", quoteId: w.byId("n1").quoteId, txHash: H(2) }]);
  });

  it("decline → quote_declined: nothing built, signed or recorded, and no automatic re-quote", async () => {
    const w = world();
    const { confirmQuote } = reviewer(w, () => "decline");
    const r = await w.runner({ confirmQuote }).run(PLAN);
    expect(r).toMatchObject({ kind: "quote_declined", code: "DECLINED", nodeId: "n1", quoteId: w.byId("n1").quoteId, txHash: null });
    expect([w.counts.build, w.counts.tx, w.counts.quote]).toEqual([0, 0, 1]);
    expect(w.wallet.sent).toEqual([]);
    expect(w.log.some((l) => l.startsWith("journal:save"))).toBe(false);
  });

  it("anything but an explicit \"continue\" is not a continue (undefined, true, 'yes', objects)", async () => {
    for (const answer of [undefined, null, true, "yes", "Continue", { decision: "continue" }, 1]) {
      const w = world();
      const { confirmQuote } = reviewer(w, () => answer as unknown as QuoteDecision);
      expect(await w.runner({ confirmQuote }).run(PLAN)).toMatchObject({ kind: "quote_declined", code: "NO_DECISION" });
      expect([w.counts.build, w.wallet.sent.length]).toEqual([0, 0]);
    }
  });

  it("a review that throws → quote_declined (CONFIRMATION_ERROR); fails closed, no retry", async () => {
    const w = world();
    const { confirmQuote } = reviewer(w, () => { throw new Error("modal crashed"); });
    expect(await w.runner({ confirmQuote }).run(PLAN)).toMatchObject({ kind: "quote_declined", code: "CONFIRMATION_ERROR" });
    expect([w.counts.build, w.counts.quote, w.wallet.sent.length]).toEqual([0, 1, 0]);
  });

  it("a slow review: the server refuses the stale binding → bind_failed EXPIRED; nothing built or signed; no silent refresh", async () => {
    const w = world();
    const { confirmQuote } = reviewer(w, () => { w.t.now += 91_000; return "continue"; });
    expect(await w.runner({ confirmQuote }).run(PLAN)).toMatchObject({ kind: "bind_failed", code: "EXPIRED", status: 410 });
    expect([w.counts.build, w.counts.quote, w.wallet.sent.length]).toEqual([0, 1, 0]);
  });

  it("re-quoted elsewhere during the review: the stale token is refused → bind_failed; nothing built", async () => {
    const w = world();
    const { confirmQuote } = reviewer(w, () => { w.byId("n1").quoteId = QID(900); return "continue"; });
    expect(await w.runner({ confirmQuote }).run(PLAN)).toMatchObject({ kind: "bind_failed", code: "NOT_FOUND" });
    expect([w.counts.build, w.wallet.sent.length]).toEqual([0, 0]);
  });

  it("aborted during the review → aborted; nothing built", async () => {
    const w = world();
    const ac = new AbortController();
    const { confirmQuote } = reviewer(w, () => { ac.abort(); return "continue"; });
    expect((await w.runner({ confirmQuote }).run(PLAN, { signal: ac.signal })).kind).toBe("aborted");
    expect(w.counts.build).toBe(0);
  });

  it("without the port, behaviour is exactly as before: one bind, no review", async () => {
    const w = world();
    await w.run();
    expect(w.log.filter((l) => l === "bind:n1")).toHaveLength(1);
    expect(w.log).not.toContain("review");
  });

  it("each step of a multi-step plan is reviewed before it is built", async () => {
    const w = world([{ nodeId: "n1" }, { nodeId: "n2", dependsOn: ["n1"] }]);
    const { seen, confirmQuote } = reviewer(w);
    expect((await w.runner({ confirmQuote }).run(PLAN)).kind).toBe("completed");
    expect(seen.map((q) => q.nodeId)).toEqual(["n1", "n2"]);
    expect(w.log.indexOf("quote:n2")).toBeGreaterThan(w.log.indexOf("settle:n1"));
  });

  it("a non-function confirmQuote / onEvent is a configuration error", () => {
    const w = world();
    expect(() => createPlanRunner(w.deps({ confirmQuote: "continue" as never }))).toThrow(PlanRunnerConfigError);
    expect(() => createPlanRunner(w.deps({ onEvent: {} as never }))).toThrow(PlanRunnerConfigError);
  });
});

describe("5C-1 — onEvent: deterministic, safe progress events", () => {
  function listen(_w: World) {
    const events: RunnerEvent[] = [];
    return { events, onEvent: (e: RunnerEvent) => { events.push(structuredClone(e)); } };
  }
  const phases = (events: RunnerEvent[]) => events.map((e) => e.phase + (e.signature ? `:${e.signature}` : ""));

  it("one step with a review: the full lifecycle, in order", async () => {
    const w = world();
    const { events, onEvent } = listen(w);
    const r = await w.runner({ onEvent, confirmQuote: async () => "continue" }).run(PLAN);
    expect(r.kind).toBe("completed");
    expect(phases(events)).toEqual([
      "quoting", "binding", "waiting_for_quote_review", "building", "waiting_for_wallet:action",
      "recording", "waiting_for_receipt:action", "confirming", "settling", "completed",
    ]);
    expect(events.find((e) => e.phase === "recording")).toMatchObject({ nodeId: "n1", txHash: H(1) });
    expect(events.find((e) => e.phase === "waiting_for_quote_review")!.quote).toMatchObject({ nodeId: "n1", quoteId: w.byId("n1").quoteId });
    expect(events.every((e) => e.planId === PLAN)).toBe(true);
  });

  it("approvals, polling and failures are reported; a decline ends with a failed event carrying the outcome", async () => {
    const a = world([{ nodeId: "n1", approve: true }]);
    a.confirmScript.push({ status: 502, body: { ok: false } });
    const la = listen(a);
    await a.runner({ onEvent: la.onEvent }).run(PLAN);
    expect(phases(la.events)).toEqual([
      "quoting", "binding", "building", "waiting_for_wallet:approval", "waiting_for_receipt:approval", "waiting_for_wallet:action",
      "recording", "waiting_for_receipt:action", "confirming", "settling", "polling", "confirming", "settling", "completed",
    ]);
    expect(la.events.find((e) => e.phase === "polling")).toMatchObject({ delayMs: 5_000 });

    const b = world();
    const lb = listen(b);
    await b.runner({ onEvent: lb.onEvent, confirmQuote: async () => "decline" }).run(PLAN);
    expect(lb.events.at(-1)).toMatchObject({ phase: "failed", nodeId: "n1", outcome: { kind: "quote_declined", code: "DECLINED" } });
  });

  it("journal replay reports recording; a resumed submitted step reports confirming/settling — never quoting or signing", async () => {
    const w = world();
    w.byId("n1").quoteId = QID(1);
    w.journal.entries.set("n1", { planId: PLAN, nodeId: "n1", quoteId: QID(1), txHash: H(5) });
    const { events, onEvent } = listen(w);
    await w.runner({ onEvent }).run(PLAN);
    expect(phases(events)).toEqual(["recording", "confirming", "settling", "completed"]);
  });

  it("events never carry the quote token, token hashes or calldata", async () => {
    const w = world([{ nodeId: "n1", approve: true }]);
    const { events, onEvent } = listen(w);
    await w.runner({ onEvent, confirmQuote: async () => "continue" }).run(PLAN);
    const json = JSON.stringify(events);
    expect(json).not.toMatch(/tok-/);
    expect(json).not.toMatch(/quoteToken|quoteTokenHash|termsHash|inputsHash|graphHash/);
    expect(json).not.toContain("0xabcdef01"); // the action's calldata
    expect(json).not.toContain("0x095ea7b3"); // the approval's calldata
  });

  it("a throwing or mutating listener can't affect the run or the review", async () => {
    const w = world();
    const seen: QuoteProjection[] = [];
    const onEvent = (e: RunnerEvent) => {
      if (e.quote) (e.quote as { summary: string }).summary = "tampered";
      throw new Error("listener bug");
    };
    const r = await w.runner({ onEvent, confirmQuote: async (q) => { seen.push(q); return "continue"; } }).run(PLAN);
    expect(r.kind).toBe("completed");
    expect(seen[0].summary).toBe("s");
  });

  it("no events are emitted without a listener, and an already-running instance emits nothing", async () => {
    const w = world();
    const { events, onEvent } = listen(w);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const real = w.plans.settle;
    w.plans.settle = async (p, n) => { await gate; return real(p, n); };
    const runner = w.runner({ onEvent });
    const first = runner.run(PLAN);
    await vi.waitFor(() => expect(events.some((e) => e.phase === "settling")).toBe(true));
    const count = events.length;
    expect((await runner.run(PLAN)).kind).toBe("already_running");
    expect(events.length).toBe(count);
    release();
    await first;
  });
});

describe("5C-1 — source guards", () => {
  const src = readFileSync(join(__dirname, "..", "lib", "plans-client", "runner.ts"), "utf8");
  it("the quote projection is built field by field and never mentions the token", () => {
    const body = src.slice(src.indexOf("function projectQuote"), src.indexOf("function parseBound"));
    expect(body.length).toBeGreaterThan(50);
    expect(body.includes("quoteToken")).toBe(false);
    expect(body).not.toMatch(/\.\.\.q\b(?!\.)/); // no spreading the whole quote
  });
  it("no emitted event or review argument names the token; still no imports, UI, storage or locks", () => {
    for (const m of src.matchAll(/emit\(\{[^;]*?\}\)/g)) expect(m[0].includes("quoteToken"), m[0]).toBe(false);
    for (const m of src.matchAll(/confirmQuote\(([^)]*)\)/g)) expect(m[1].includes("quoteToken")).toBe(false);
    expect(src).not.toMatch(/^\s*import\s/m);
    for (const word of ["localStorage", "navigator.locks", "react", "useState", "useEffect", "document."]) expect(src.includes(word), word).toBe(false);
  });
});

/* ══ 5C-2b — cross-tab execution lock ══════════════════════════════════════ */

describe("5C-2b — execution lock: the whole run happens inside one wallet + plan lock", () => {
  /** A manual gate: `wait` pends until `open()`. */
  const gate = () => {
    let open!: () => void;
    const wait = new Promise<void>((r) => { open = r; });
    return { wait, open };
  };
  const PLAN2 = `plan_${"b".repeat(32)}`;
  /** Nothing at all was called: no grant, journal, Plan API, SDK or wallet. */
  const nothingCalled = (w: World) => {
    expect(w.log).toEqual([]);
    expect(Object.values(w.counts).every((c) => c === 0)).toBe(true);
    expect(w.wallet.sent).toEqual([]);
    expect(signs(w)).toEqual([]);
    expect(w.seen.txs).toEqual([]);
  };

  it("held → already_running / LOCK_HELD, and nothing at all is called", async () => {
    const w = world();
    w.lock.mode = "held";
    const r = await w.run();
    expect(r).toMatchObject({ kind: "already_running", code: "LOCK_HELD", planId: PLAN, nodeId: null, txHash: null, plan: null });
    expect(r.message).toMatch(/another tab or window/);
    expect(w.lock.scopes).toEqual([{ wallet: WALLET, planId: PLAN }]);
    nothingCalled(w);
  });
  it("unavailable → lock_unavailable / LOCK_UNAVAILABLE, and nothing at all is called", async () => {
    const w = world();
    w.lock.mode = "unavailable";
    expect(await w.run()).toMatchObject({ kind: "lock_unavailable", code: "LOCK_UNAVAILABLE", nodeId: null, txHash: null });
    nothingCalled(w);
  });
  it("a throwing lock → lock_unavailable (fail closed), and nothing at all is called", async () => {
    const w = world();
    w.lock.mode = "throw";
    expect(await w.run()).toMatchObject({ kind: "lock_unavailable", code: "LOCK_UNAVAILABLE" });
    nothingCalled(w);
  });
  it("a malformed lock result (or 'ran' without running the task) → lock_unavailable, nothing called", async () => {
    for (const res of [undefined, null, {}, { status: "ok" }, { status: "ran", value: { kind: "completed" } }, "held"]) {
      const w = world();
      const r = await w.run({ lock: { runExclusive: async () => res as never } });
      expect(r).toMatchObject({ kind: "lock_unavailable", code: "LOCK_UNAVAILABLE" });
      nothingCalled(w);
    }
  });
  it("lock failure leaves a pre-seeded journal byte-for-byte untouched (no load, save or clear)", async () => {
    for (const mode of ["held", "unavailable", "throw"] as const) {
      const w = world();
      w.nodes[0].txHash = null;
      const store = new Map<string, string>();
      const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
      const journal = createLocalJournal({ storage, wallet: WALLET, planId: PLAN });
      journal.save({ planId: PLAN, nodeId: "n1", quoteId: QID(7), txHash: H(7) });
      const before = new Map(store);
      const spy = { getItem: vi.fn(storage.getItem), setItem: vi.fn(storage.setItem), removeItem: vi.fn(storage.removeItem) };
      w.lock.mode = mode;
      const r = await w.run({ journal: createLocalJournal({ storage: spy, wallet: WALLET, planId: PLAN }) });
      expect(["already_running", "lock_unavailable"]).toContain(r.kind);
      expect(store).toEqual(before);
      expect(spy.getItem).not.toHaveBeenCalled();
      expect(spy.setItem).not.toHaveBeenCalled();
      expect(spy.removeItem).not.toHaveBeenCalled();
      nothingCalled(w);
    }
  });
  it("no local wallet → wallet_locked before the lock is even asked for", async () => {
    for (const address of [null, "0x123", ""]) {
      const w = world();
      w.wallet.address = address;
      expect((await w.run()).kind).toBe("wallet_locked");
      expect(w.lock.scopes).toEqual([]);
      nothingCalled(w);
    }
  });
  it("the lock scope is the LOCAL wallet, lowercased, and the plan id", async () => {
    const w = world();
    w.wallet.address = WALLET.toUpperCase().replace("0X", "0x");
    expect((await w.run()).kind).toBe("completed");
    expect(w.lock.scopes).toEqual([{ wallet: WALLET, planId: PLAN }]);
  });

  /* ── contention: the lock is held for the whole run ── */

  const contend = async (w: World, a: ReturnType<World["runner"]>, waitFor: () => void, release: () => void) => {
    const first = a.run(PLAN);
    await vi.waitFor(waitFor);
    const calls = w.log.length;
    const sent = w.wallet.sent.length;
    const second = w.runner(); // another runner (another tab) on the same lock
    expect(await second.run(PLAN)).toMatchObject({ kind: "already_running", code: "LOCK_HELD" });
    expect(w.log.length).toBe(calls); // the second made no calls at all
    expect(w.wallet.sent.length).toBe(sent);
    expect(w.lock.held.size).toBe(1);
    release();
    const r = await first;
    expect(w.lock.held.size).toBe(0);
    return { r, second };
  };

  it("held while the quote is under review (confirmQuote)", async () => {
    const w = world();
    const g = gate();
    const a = w.runner({ confirmQuote: async () => { await g.wait; return "continue"; } });
    const { r } = await contend(w, a, () => expect(w.log).toContain("bind:n1"), g.open);
    expect(r.kind).toBe("completed");
    expect(signs(w)).toEqual(["sign:action"]);
  });
  it("held while the wallet pop-up is open (sendTransaction), then released after completion", async () => {
    const w = world();
    const g = gate();
    w.wallet.sendQueue.push(async () => { await g.wait; return H(1); });
    const { r, second } = await contend(w, w.runner(), () => expect(signs(w)).toEqual(["sign:action"]), g.open);
    expect(r.kind).toBe("completed");
    expect(signs(w)).toEqual(["sign:action"]);
    // Released: the other runner can now take the lock (and finds the plan done).
    expect((await second.run(PLAN)).kind).toBe("completed");
    expect(signs(w)).toEqual(["sign:action"]);
  });
  it("held during settlement polling", async () => {
    const w = world();
    const g = gate();
    let pending = 0;
    w.ov.settle = () => (++pending === 1 ? err(202, "SETTLEMENT_PENDING") : undefined);
    const clock: Clock = { now: () => w.t.now, async sleep(ms, s) { await g.wait; return w.clock.sleep(ms, s); } };
    const a = w.runner({ clock });
    const { r } = await contend(w, a, () => expect(pending).toBe(1), g.open);
    expect(r.kind).toBe("completed");
  });
  it("held during journal recovery: the other runner can't replay or sign", async () => {
    const w = world();
    Object.assign(w.byId("n1"), { quoteId: QID(9), quotes: 1, quotedAt: w.t.now }); // quoted and sent in an earlier run
    w.journal.entries.set("n1", { planId: PLAN, nodeId: "n1", quoteId: QID(9), txHash: H(9) });
    const g = gate();
    let replaying = false;
    const realTx = w.plans.tx;
    w.plans.tx = async (p, n, i) => { if (!replaying) { replaying = true; await g.wait; } return realTx(p, n, i); };
    const { r } = await contend(w, w.runner(), () => expect(replaying).toBe(true), g.open);
    expect(r.kind).toBe("completed");
    expect(signs(w)).toEqual([]); // recovered, never signed
    expect(w.seen.txs).toEqual([{ nodeId: "n1", quoteId: QID(9), txHash: H(9) }]);
  });
  it("same wallet, different plans: each has its own lock and both complete", async () => {
    const lock = fakeLock();
    const w1 = world([{ nodeId: "n1" }], { lock });
    const w2 = world([{ nodeId: "n1" }], { planId: PLAN2, lock });
    const g = gate();
    w1.wallet.sendQueue.push(async () => { await g.wait; return H(1); });
    const first = w1.runner().run(PLAN);
    await vi.waitFor(() => expect(signs(w1)).toEqual(["sign:action"]));
    expect((await w2.runner().run(PLAN2)).kind).toBe("completed");
    expect(lock.scopes).toEqual([{ wallet: WALLET, planId: PLAN }, { wallet: WALLET, planId: PLAN2 }]);
    g.open();
    expect((await first).kind).toBe("completed");
    expect(lock.held.size).toBe(0);
  });

  /* ── release ── */

  it("released after a failed run, after an abort and after a thrown run", async () => {
    const w = world();
    w.flags.approved = false;
    expect((await w.run()).kind).toBe("not_approved");
    expect(w.lock.held.size).toBe(0);

    const ac = new AbortController();
    ac.abort();
    expect((await w.runner().run(PLAN, { signal: ac.signal })).kind).toBe("aborted");
    expect(w.lock.held.size).toBe(0);

    w.flags.approved = true;
    const runner = w.runner({ clock: { now: () => { throw new Error("clock broke"); }, sleep: w.clock.sleep } });
    await expect(runner.run(PLAN)).rejects.toThrow("clock broke");
    expect(w.lock.held.size).toBe(0);
    expect(runner.running).toBe(false);

    expect((await w.run()).kind).toBe("completed"); // reacquired
    expect(w.lock.scopes).toHaveLength(4);
  });
  it("aborting mid-run releases the lock once the run stops", async () => {
    const w = world();
    const ac = new AbortController();
    const a = w.runner({ confirmQuote: async () => { ac.abort(); return "continue"; } });
    const r = await a.run(PLAN, { signal: ac.signal });
    expect(r.kind).toBe("aborted");
    expect(signs(w)).toEqual([]);
    expect(w.lock.held.size).toBe(0);
  });

  /* ── wallet consistency ── */

  it("a wallet switch after the lock was taken → wallet_mismatch before the next step is quoted", async () => {
    const w = world([{ nodeId: "n1" }, { nodeId: "n2", dependsOn: ["n1"] }]);
    w.ov.settle = () => {
      if (w.byId("n1").txHash && !w.byId("n1").result) { w.wallet.address = OTHER; w.grant.address = OTHER; }
      return undefined;
    };
    const r = await w.run();
    expect(r.kind).toBe("wallet_mismatch");
    expect(w.counts.quote).toBe(1);
    expect(signs(w)).toEqual(["sign:action"]);
    expect(w.lock.held.size).toBe(0);
  });

  /* ── configuration ── */

  it("a lock is REQUIRED: missing or malformed → PlanRunnerConfigError", () => {
    const w = world();
    for (const lock of [undefined, null, {}, { runExclusive: true }, { run: async () => ({}) }, () => {}]) {
      expect(() => createPlanRunner({ ...w.deps(), lock: lock as never })).toThrow(/execution lock/);
    }
    expect(() => createPlanRunner(w.deps())).not.toThrow();
  });

  /* ── what actually ran is never hidden ── */

  it("an adapter that reports unavailable or throws AFTER running the task can't hide the real outcome", async () => {
    for (const after of ["unavailable", "held", "throw"] as const) {
      const w = world();
      const r = await w.run({
        lock: {
          async runExclusive(_s, task) {
            await task();
            if (after === "throw") throw new Error("release failed");
            return { status: after } as never;
          },
        },
      });
      expect(r.kind).toBe("completed");
      expect(signs(w)).toEqual(["sign:action"]);
    }
  });
  it("an adapter that calls the task twice still runs the plan once", async () => {
    const w = world();
    const second: unknown[] = [];
    const r = await w.run({
      lock: {
        async runExclusive(_s, task) {
          const v = await task();
          second.push(await task());
          return { status: "ran", value: v };
        },
      },
    });
    expect(r.kind).toBe("completed");
    expect(second).toEqual([expect.objectContaining({ kind: "lock_unavailable", code: "LOCK_REENTERED" })]);
    expect(signs(w)).toEqual(["sign:action"]);
    expect(w.counts.quote).toBe(1);
  });
  it("an adapter that settles before the task finishes: the run's own outcome is still awaited and returned", async () => {
    const w = world();
    const r = await w.run({ lock: { async runExclusive(_s, task) { void task(); return { status: "unavailable" }; } } });
    expect(r.kind).toBe("completed");
    expect(signs(w)).toEqual(["sign:action"]);
  });

  /* ── with the real Web Locks adapter ── */

  it("with createWebExecutionLock over a fake LockManager: a second runner is refused while the first signs", async () => {
    const held = new Set<string>();
    const manager = {
      async request(name: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) {
        if (held.has(name)) return cb(null);
        held.add(name);
        try { return await cb({ name }); } finally { held.delete(name); }
      },
    };
    const w = world();
    const lock = createWebExecutionLock(manager);
    const g = gate();
    w.wallet.sendQueue.push(async () => { await g.wait; return H(1); });
    const first = w.runner({ lock }).run(PLAN);
    await vi.waitFor(() => expect(signs(w)).toEqual(["sign:action"]));
    expect([...held]).toEqual([`payai_plan_run:${WALLET}:${PLAN}`]);
    const calls = w.log.length;
    expect(await w.runner({ lock }).run(PLAN)).toMatchObject({ kind: "already_running", code: "LOCK_HELD" });
    expect(w.log.length).toBe(calls);
    g.open();
    expect((await first).kind).toBe("completed");
    expect(held.size).toBe(0);
    expect(await w.runner({ lock: createWebExecutionLock(null) }).run(PLAN)).toMatchObject({ kind: "lock_unavailable" });
  });
});
