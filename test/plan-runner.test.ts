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
  type BoundQuoteDTO, type BuildStepDTO, type Clock, type HttpFn, type JournalEntry, type NextStepDTO,
  type NodeStateDTO, type PlanRunnerDeps, type PlanStateDTO, type PlanTransport, type PlanViewDTO, type Reply,
  type RunnerWallet, type SdkTransport, type StepQuoteDTO,
} from "@/lib/plans-client/runner";

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
  quoteId: string | null; quotes: number; txHash: string | null;
  result: { status: "confirmed" | "reverted" | "unverified"; outputs: null } | null;
}

const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...body } });
const err = (status: number, code: string, message = code): Reply => ({ status, body: { ok: false, code, message } });

function world(specs: NodeSpec[] = [{ nodeId: "n1" }]) {
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
    planId: PLAN, state: planState(), approved: flags.approved, abandoned: flags.abandoned, expired: false, approvable: false,
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
      return ok({ quote: { nodeId, ref: { ...REF }, attempt: n.quotes, quoteId: n.quoteId, quoteToken: `tok-${n.quoteId}`, inputs: { amount: "100", recipient: OTHER }, summary: "s", details: {}, quotedAt: t.now } });
    },
    async bind(_p, nodeId, token) {
      log.push(`bind:${nodeId}`);
      const o = hook("bind", nodeId, token); if (o) return o;
      const n = byId(nodeId);
      if (token !== `tok-${n.quoteId}`) return err(404, "NOT_FOUND");
      return ok({ bound: { nodeId, ref: { ...REF }, attempt: n.quotes, quoteId: n.quoteId, quotedAt: t.now, freshUntil: t.now + 90_000 } });
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
  const deps = (o: Partial<PlanRunnerDeps> = {}): PlanRunnerDeps => ({ wallet, plans, sdk, grant, clock, journal, chainId: CHAIN, ...o });
  const runner = (o: Partial<PlanRunnerDeps> = {}) => createPlanRunner(deps(o));
  const run = (o: Partial<PlanRunnerDeps> = {}) => runner(o).run(PLAN);
  return { log, t, clock, flags, nodes, byId, verdicts, outcomeOf, confirmScript, ov, counts, seen, plans, sdk, wallet, grant, journal, deps, runner, run, view };
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
      wallet, plans, sdk, grant: t.grant, clock, chainId: 143,
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
