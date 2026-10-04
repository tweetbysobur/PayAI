import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Action, ActionInputs, ProtocolAdapter } from "@/lib/sdk/types";

/**
 * Phase 2C Stage 3C — the Plan API (app/api/plans/**, lib/plan/http.ts).
 *
 * Real: the routes, wallet-grant cookies (encodeWalletGrant), the rate
 * limiter, the Plan Service and Store (in-memory), the canonical quote
 * helper and quote tokens, and the SDK build / settle / output records.
 * Mocked (as in test/plan-service.test.ts): the recipient resolver, the
 * live fee read and the payment policy.
 */

const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const OTHER_WALLET = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const RECIPIENT = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const MIN = 60_000;

const ctl = vi.hoisted(() => ({
  resolutions: new Map<string, unknown>(),
  feeBps: 25 as number | null,
  policy: null as null | { allowed: boolean; reason?: string },
  quoteThrows: null as null | "internal",
  buildCalls: 0,
  /** Make the real limiter throw (as a KV/network failure would) for one layer. */
  limiterThrows: null as null | "ip" | "wallet",
  /** Make grant decoding throw (an unexpected failure inside it). */
  grantThrows: false,
}));
vi.mock("@/lib/auth/walletGrant", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/walletGrant")>();
  return {
    ...actual,
    decodeWalletGrant: (...a: Parameters<typeof actual.decodeWalletGrant>) => {
      if (ctl.grantThrows) throw new Error("grant keyring unavailable: /etc/secrets/session");
      return actual.decodeWalletGrant(...a);
    },
  };
});
vi.mock("@/lib/platform/ratelimit", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/platform/ratelimit")>();
  return {
    ...actual,
    rateLimited: (...a: Parameters<typeof actual.rateLimited>) => {
      const bucket = a[1] ?? "";
      if (ctl.limiterThrows === "ip" && bucket === "plans-ip") return Promise.reject(new Error("KV ECONNRESET at redis-internal.example:6379"));
      if (ctl.limiterThrows === "wallet" && bucket.startsWith("plans-") && bucket !== "plans-ip") return Promise.reject(new Error("KV ECONNRESET at redis-internal.example:6379"));
      return actual.rateLimited(...a);
    },
  };
});
vi.mock("@/lib/payees/resolve", () => ({
  resolveRecipientInput: async (input: string) =>
    ctl.resolutions.get(input.trim().toLowerCase()) ?? { ok: false, message: `"${input}" isn't a valid address, .nad domain, or known payee.` },
}));
vi.mock("@/lib/sdk/fees", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sdk/fees")>();
  return { ...actual, readPlatformFeeTerms: async () => ({ feeBps: ctl.feeBps ?? 25, treasury: "0xA282833B52b1B66D58bD2007081dCC037798C0b0", source: "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D" }) };
});
vi.mock("@/lib/sdk/policy", () => ({
  enforcePaymentPolicy: async () => ctl.policy
    ? { allowed: ctl.policy.allowed, reason: ctl.policy.reason, warnings: [], riskScore: 90, riskLevel: "high", compliance: "rejected" }
    : { allowed: true, warnings: [], riskScore: 5, riskLevel: "low", compliance: "approved" },
}));

function fixture(protocolId: string, action: Omit<Action, "protocolId" | "chainId" | "allowedTargets" | "quote" | "build" | "parseResult">): ProtocolAdapter {
  const target = "0x00000000000000000000000000000000000000f1" as const;
  return {
    protocolId, name: `${protocolId} (test fixture)`, chainId: 143, allowedTargets: [target],
    actions: [{
      ...action, protocolId, chainId: 143, allowedTargets: [target],
      async quote(inputs: ActionInputs) {
        if (ctl.quoteThrows === "internal") throw new Error("engine down: secret-internal-detail");
        void inputs;
        return { summary: `${action.actionId} quote`, details: {}, quotedAt: Date.now(), terms: action.feePolicy ? { feeBps: String(ctl.feeBps) } : { kind: action.actionId } };
      },
      async build() { ctl.buildCalls++; throw new Error("build must not be called"); },
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
  Object.assign(ctl, { feeBps: 25, policy: null, quoteThrows: null, buildCalls: 0, limiterThrows: null, grantThrows: false });
  ctl.resolutions.clear();
  ctl.resolutions.set("alice", { ok: true, address: ALICE, source: "payee", display: "Alice", domain: null, asResolved: ALICE });
  ctl.resolutions.set("bob.nad", { ok: true, address: BOB, source: "nad", display: "bob.nad", domain: "bob.nad", asResolved: BOB });
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
  for (const p of [TRANSFER, SWAP]) registerProtocol(p);
});
afterEach(() => {
  if (savedNetwork === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = savedNetwork;
  if (savedUsdc === undefined) delete process.env.MONAD_MAINNET_USDC; else process.env.MONAD_MAINNET_USDC = savedUsdc;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/* ── Drafts ────────────────────────────────────────────────────────────── */

type Ref = [string, string, string];
const T: Ref = ["payai", "transfer", "1.0.0"];
const S: Ref = ["payai-swap", "swap", "1.0.0"];
const lit = (value: string) => ({ kind: "literal", value });
const out = (node: string, output: string) => ({ kind: "output", node, output });
const addr = (a: string) => ({ kind: "recipient", display: a, source: "address", address: a });
function node(nodeId: string, ref: Ref, inputs: Record<string, unknown>, dependsOn: string[] = []) {
  return { nodeId, ref: { protocolId: ref[0], actionId: ref[1], version: ref[2] }, inputs, dependsOn, validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" } };
}
function graph(nodes: unknown[], text: string, id = "intent_api_00001", wallet = WALLET) {
  return { id, version: 1, chainId: 143, wallet, nodes, status: "draft", source: { text, adapter: "deterministic", adapterVersion: "1" } };
}
const sendDraft = (id?: string, wallet?: string) => graph([
  node("n1", S, { tokenOut: lit(USDC), amountIn: lit("100000000000000000000") }),
  node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "amountOut") }, ["n1"]),
], `swap 100 MON to USDC and send the USDC to ${RECIPIENT}`, id, wallet);
const singleDraft = (id?: string) => graph([node("n1", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: lit("1000000") })], `send 1 USDC to ${RECIPIENT}`, id);

/* ── HTTP helpers ──────────────────────────────────────────────────────── */

const BASE = "https://app.usepayai.xyz";
async function cookieFor(wallet: string, expiresAt = Date.now() + 60 * MIN) {
  const { encodeWalletGrant, WALLET_GRANT_COOKIE } = await import("@/lib/auth/walletGrant");
  return `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(wallet, expiresAt)}`;
}
interface Opts { wallet?: string | null; cookie?: string; ip?: string; headers?: Record<string, string>; raw?: string }
async function request(method: string, path: string, body?: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "x-real-ip": o.ip ?? "203.0.113.7", ...(o.headers ?? {}) };
  const cookie = o.cookie ?? (o.wallet === null ? undefined : await cookieFor(o.wallet ?? WALLET));
  if (cookie) headers.cookie = cookie;
  if (body !== undefined || o.raw !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${BASE}${path}`, { method, headers, ...(o.raw !== undefined ? { body: o.raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function send(res: Promise<Response> | Response) {
  const r = await res;
  const text = await r.text();
  return { status: r.status, cache: r.headers.get("cache-control"), json: text ? JSON.parse(text) : null, text };
}
async function collection() { return import("@/app/api/plans/route"); }
async function single() { return import("@/app/api/plans/[planId]/route"); }
const ctx = (planId: string) => ({ params: Promise.resolve({ planId }) });

async function list(o?: Opts) { const { GET } = await collection(); return send(GET(await request("GET", "/api/plans", undefined, o))); }
async function create(draft: unknown, o?: Opts) { const { POST } = await collection(); return send(POST(await request("POST", "/api/plans", { draft }, o))); }
async function get(planId: string, o?: Opts) { const { GET } = await single(); return send(GET(await request("GET", `/api/plans/${planId}`, undefined, o), ctx(planId))); }
async function op(planId: string, body: unknown, o?: Opts) { const { POST } = await single(); return send(POST(await request("POST", `/api/plans/${planId}`, body, o), ctx(planId))); }

/* ── SDK records, as the build / confirm routes write them ─────────────── */

let seq = 0;
const txHash = () => `0x${(++seq).toString(16).padStart(64, "d")}`;
async function seedBuild(quoteId: string, ref: Ref, wallet = WALLET) {
  const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
  const { buildKey } = await import("@/lib/sdk/settlement");
  await claimRequest(buildKey(quoteId));
  await completeRequest(buildKey(quoteId), { protocolId: ref[0], actionId: ref[1], version: ref[2], wallet: wallet.toLowerCase(), finalTx: { to: "0x00000000000000000000000000000000000000f1", data: "0x", value: "0" }, riskScore: null, compliance: null, builtAt: Date.now() });
}
async function seedVerdict(tx: string, body: Record<string, unknown>) {
  const { claimRequest, completeRequest } = await import("@/lib/platform/idempotency");
  const { settleKey } = await import("@/lib/sdk/settlement");
  await claimRequest(settleKey(tx));
  await completeRequest(settleKey(tx), body);
}
const OK_VERDICT = { ok: true, success: true, explorerUrl: "x", details: {}, recorded: 1 };
const units = (value: string) => ({ verified: true as const, type: "units" as const, value, token: USDC });
const SWAP_OUTPUTS = { amountOut: units("100000000"), tokenOut: { verified: true as const, type: "token" as const, value: USDC } };
async function seedOutputs(quoteId: string, tx: string, ref: Ref, outputs: Record<string, unknown>) {
  const { insertOutputRecordOnce } = await import("@/lib/sdk/settlement");
  return insertOutputRecordOnce({ quoteId, txHash: tx, wallet: WALLET, protocolId: ref[0], actionId: ref[1], version: ref[2], outputs: outputs as never, recordedAt: Date.now() });
}

/** Approval as SETUP for post-approval behaviour: straight through the store,
 *  which skips only the service's Stage 5B review guard (these drafts use
 *  test-only actions that are deliberately not reviewable). API approval
 *  itself is tested with reviewable plans (singleDraft). */
async function storeApprove(planId: string) {
  const store = await import("@/lib/plan/store");
  await store.approvePlan(planId, { sessionWallet: WALLET, activeChainId: 143 });
}
async function approvedPlan(draft: unknown = sendDraft()) {
  const c = await create(draft);
  expect(c.status).toBe(200);
  const planId = c.json.plan.planId as string;
  await storeApprove(planId);
  return planId;
}
/** quote → bind → (build) → tx → (confirm) → settle, through the API. */
async function runStep(planId: string, nodeId: string, ref: Ref, o: { outputs?: Record<string, unknown> | null; verdict?: Record<string, unknown> } = {}) {
  const q = await op(planId, { op: "quote", nodeId });
  expect(q.status).toBe(200);
  const quote = q.json.quote;
  expect((await op(planId, { op: "bind", nodeId, quoteToken: quote.quoteToken })).status).toBe(200);
  await seedBuild(quote.quoteId, ref);
  const tx = txHash();
  expect((await op(planId, { op: "tx", nodeId, quoteId: quote.quoteId, txHash: tx })).status).toBe(200);
  await seedVerdict(tx, o.verdict ?? OK_VERDICT);
  if (o.outputs !== null) await seedOutputs(quote.quoteId, tx, ref, o.outputs ?? SWAP_OUTPUTS);
  const settled = await op(planId, { op: "settle", nodeId });
  return { quote, tx, settled };
}

/* ══ Happy path ═════════════════════════════════════════════════════════ */

describe("the full lifecycle over HTTP", () => {
  it("create → approve → next → quote → bind → tx → settle, both steps, to completed — every response no-store", async () => {
    const c = await create(sendDraft());
    expect(c).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, plan: { state: "planned", currentStep: "n1" } } });
    const planId = c.json.plan.planId;
    await storeApprove(planId); // the swap fixture is test-only (not reviewable); API approval is covered with reviewable plans
    expect(await op(planId, { op: "next" })).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, next: { nodeId: "n1", quotable: true } } });
    const s1 = await runStep(planId, "n1", S);
    expect(s1.settled).toMatchObject({ status: 200, cache: "no-store", json: { plan: { nodes: [{ state: "confirmed" }, { state: "pending" }] } } });
    const s2 = await runStep(planId, "n2", T, { outputs: { amount: units("1") } });
    expect(s2.settled.json.plan.state).toBe("completed");
    expect(await get(planId)).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, plan: { state: "completed", currentStep: null } } });
    expect(await list()).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, plans: [{ planId, state: "completed" }] } });
    expect(ctl.buildCalls).toBe(0);
  });

  it("the raw quote token appears ONLY in the quote response; no response carries hashes, keys or internal records", async () => {
    const planId = await approvedPlan();
    const q = await op(planId, { op: "quote", nodeId: "n1" });
    const token = q.json.quote.quoteToken as string;
    expect(q.text).toContain(token);
    const hash = createHash("sha256").update(token).digest("hex");
    const bound = await op(planId, { op: "bind", nodeId: "n1", quoteToken: token });
    await seedBuild(q.json.quote.quoteId, S);
    const tx = await op(planId, { op: "tx", nodeId: "n1", quoteId: q.json.quote.quoteId, txHash: txHash() });
    for (const r of [bound, tx, await get(planId), await list(), await op(planId, { op: "next" })]) {
      for (const bad of [token, hash, "quoteTokenHash", "termsHash", "inputsHash", "graphHash", "veripay:", "draft", "pins\""]) {
        expect(r.text.includes(bad), `${bad} in ${r.text.slice(0, 80)}`).toBe(false);
      }
      expect(r.cache).toBe("no-store");
    }
    expect(q.text.includes(hash)).toBe(false);
  });
});

/* ══ Authentication ═════════════════════════════════════════════════════ */

describe("authentication: the wallet grant is the only identity", () => {
  it("missing, forged and expired grants are 401 (no-store) on every endpoint", async () => {
    const planId = await approvedPlan();
    const { WALLET_GRANT_COOKIE } = await import("@/lib/auth/walletGrant");
    for (const o of [
      { wallet: null },
      { cookie: `${WALLET_GRANT_COOKIE}=aaaa.bbbb` },
      { cookie: await cookieFor(WALLET, Date.now() - 1) },
    ] as Opts[]) {
      for (const r of [await list(o), await create(sendDraft("intent_api_00002"), o), await get(planId, o), await op(planId, { op: "next" }, o)]) {
        expect(r).toMatchObject({ status: 401, cache: "no-store", json: { ok: false, code: "wallet_grant_required" } });
      }
    }
  });

  it("a wallet named in the body or query is never the identity", async () => {
    // Body wallet / draft wallet ≠ grant: the draft is refused for the grant's wallet.
    expect(await create(sendDraft("intent_api_00003", OTHER_WALLET))).toMatchObject({ status: 400, json: { code: "INVALID_PLAN" } });
    const planId = await approvedPlan();
    const { GET } = await collection();
    const r = await send(GET(await request("GET", `/api/plans?wallet=${OTHER_WALLET}`)));
    expect(r.json.plans.map((p: { planId: string }) => p.planId)).toEqual([planId]); // still the grant's own plans
    expect(await op(planId, { op: "next", wallet: OTHER_WALLET })).toMatchObject({ status: 200 });
    expect(await list({ wallet: OTHER_WALLET })).toMatchObject({ status: 200, json: { plans: [] } });
  });

  it("another wallet's plan is 404 — indistinguishable from a missing one — for every operation", async () => {
    const planId = await approvedPlan();
    const o = { wallet: OTHER_WALLET };
    const missing = `plan_${"9".repeat(32)}`;
    for (const r of [
      await get(planId, o), await op(planId, { op: "approve" }, o), await op(planId, { op: "abandon" }, o), await op(planId, { op: "next" }, o),
      await op(planId, { op: "quote", nodeId: "n1" }, o), await op(planId, { op: "bind", nodeId: "n1", quoteToken: "t" }, o),
      await op(planId, { op: "tx", nodeId: "n1", quoteId: "a".repeat(32), txHash: txHash() }, o), await op(planId, { op: "settle", nodeId: "n1" }, o),
    ]) expect(r).toMatchObject({ status: 404, json: { ok: false, code: "NOT_FOUND" } });
    const theirs = (await get(planId, o)).json;
    expect((await get(missing, o)).json).toEqual(theirs);
    expect((await get(planId)).status).toBe(200); // the owner still sees it, untouched
  });

  it("a merchant API key grants nothing: still 401 without the wallet grant", async () => {
    const planId = await approvedPlan();
    const r = await get(planId, { wallet: null, headers: { "x-merchant-key": "pk_live_anything" } });
    expect(r).toMatchObject({ status: 401, json: { code: "wallet_grant_required" } });
  });
});

/* ══ Input ══════════════════════════════════════════════════════════════ */

describe("input validation at the boundary", () => {
  it("malformed JSON, non-objects, oversized bodies, unknown ops and missing fields are 400 INVALID_INPUT", async () => {
    const planId = await approvedPlan();
    const { POST } = await single();
    const { POST: createPost } = await collection();
    for (const raw of ["{nope", "[1,2]", "\"str\"", "null", "x".repeat(70_000)]) {
      const r = await send(POST(await request("POST", `/api/plans/${planId}`, undefined, { raw }), ctx(planId)));
      expect(r, raw.slice(0, 10)).toMatchObject({ status: 400, cache: "no-store", json: { ok: false, code: "INVALID_INPUT" } });
    }
    expect((await send(createPost(await request("POST", "/api/plans", undefined, { raw: "{}" })))).json.code).toBe("INVALID_INPUT");
    // A VALID JSON body over the size cap is refused for its size alone.
    const big = await send(POST(await request("POST", `/api/plans/${planId}`, undefined, { raw: JSON.stringify({ op: "next", pad: "x".repeat(70_000) }) }), ctx(planId)));
    expect(big).toMatchObject({ status: 400, json: { code: "INVALID_INPUT", message: "Request body is too large." } });
    for (const body of [{}, { op: "delete" }, { op: "__proto__" }, { op: "quote" }, { op: "quote", nodeId: 7 }, { op: "bind", nodeId: "n1" },
      { op: "bind", nodeId: "n1", quoteToken: "x".repeat(4097) }, { op: "tx", nodeId: "n1", quoteId: "a".repeat(32) }, { op: "settle" }]) {
      expect(await op(planId, body), JSON.stringify(body)).toMatchObject({ status: 400, json: { code: "INVALID_INPUT" } });
    }
  });

  it("deep validation is the service's: bad ids and hashes map through PlanError", async () => {
    const planId = await approvedPlan();
    expect(await get("plan_x")).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
    expect(await op(planId, { op: "quote", nodeId: "n9" })).toMatchObject({ status: 400, json: { code: "INVALID_NODE" } });
    const q = await op(planId, { op: "quote", nodeId: "n1" });
    await seedBuild(q.json.quote.quoteId, S);
    expect(await op(planId, { op: "tx", nodeId: "n1", quoteId: q.json.quote.quoteId, txHash: "0x12" })).toMatchObject({ status: 400, json: { code: "INVALID_PLAN" } });
    expect(await create({ id: "bad" })).toMatchObject({ status: 400, json: { code: "INVALID_PLAN" } });
  });
});

/* ══ Lifecycle rules (all the service's) ════════════════════════════════ */

describe("lifecycle through the API", () => {
  it("unapproved: next/quote are 409 NOT_APPROVED; late approval 409 NOT_APPROVABLE", async () => {
    const c = await create(singleDraft());
    const planId = c.json.plan.planId;
    expect(await op(planId, { op: "next" })).toMatchObject({ status: 409, json: { code: "NOT_APPROVED" } });
    expect(await op(planId, { op: "quote", nodeId: "n1" })).toMatchObject({ status: 409, json: { code: "NOT_APPROVED" } });
    vi.setSystemTime(T0 + 31 * MIN);
    expect(await op(planId, { op: "approve" })).toMatchObject({ status: 409, json: { code: "NOT_APPROVABLE" } });
  });

  it("abandoned: approval and quotes refused (409); a signed transaction still settles", async () => {
    const planId = await approvedPlan();
    const q = await op(planId, { op: "quote", nodeId: "n1" });
    await seedBuild(q.json.quote.quoteId, S);
    expect(await op(planId, { op: "abandon" })).toMatchObject({ status: 200, json: { plan: { abandoned: true } } });
    expect(await op(planId, { op: "quote", nodeId: "n1" })).toMatchObject({ status: 409, json: { code: "STEP_NOT_READY" } });
    const tx = txHash();
    expect((await op(planId, { op: "tx", nodeId: "n1", quoteId: q.json.quote.quoteId, txHash: tx })).status).toBe(200);
    await seedVerdict(tx, OK_VERDICT);
    await seedOutputs(q.json.quote.quoteId, tx, S, SWAP_OUTPUTS);
    expect(await op(planId, { op: "settle", nodeId: "n1" })).toMatchObject({ status: 200, json: { plan: { state: "partial" } } });
    const p2 = (await create(singleDraft("intent_api_00004"))).json.plan.planId;
    await op(p2, { op: "abandon" });
    expect(await op(p2, { op: "approve" })).toMatchObject({ status: 409, json: { code: "NOT_APPROVABLE" } });
    // Approved before abandonment: re-approving is idempotent (reviewable plan, real guard).
    const p3 = (await create(singleDraft("intent_api_00005"))).json.plan.planId;
    expect(await op(p3, { op: "approve" })).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, plan: { state: "approved" } } });
    await op(p3, { op: "abandon" });
    expect(await op(p3, { op: "approve" })).toMatchObject({ status: 200, json: { plan: { approved: true, abandoned: true } } });
  });

  it("quote races never double-issue an attempt (any interleaving); the 9th attempt is 409; a non-current step is 409", async () => {
    const planId = await approvedPlan();
    // Concurrent quotes: whatever the interleaving, a loser is 409 CONFLICT and
    // every 200 is a DISTINCT recorded attempt — never two for the same number.
    const race = await Promise.all([1, 2, 3, 4].map(() => op(planId, { op: "quote", nodeId: "n1" })));
    const won = race.filter((r) => r.status === 200);
    for (const r of race) if (r.status !== 200) expect(r).toMatchObject({ status: 409, json: { code: "CONFLICT" } });
    const attempts = won.map((r) => r.json.quote.attempt as number);
    expect(new Set(attempts).size).toBe(attempts.length);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect((await get(planId)).json.plan.nodes[0].quoteAttempts).toBe(attempts.length);
    for (let n = attempts.length + 1; n <= 8; n++) expect((await op(planId, { op: "quote", nodeId: "n1" })).status).toBe(200);
    expect(await op(planId, { op: "quote", nodeId: "n1" })).toMatchObject({ status: 409, json: { code: "CONFLICT" } });
    expect(await op(planId, { op: "quote", nodeId: "n2" })).toMatchObject({ status: 409, json: { code: "STEP_NOT_READY" } });
  });

  it("quote replay: bind is repeatable for the latest token; a superseded token is 404, a stale one 410", async () => {
    const planId = await approvedPlan();
    const q1 = (await op(planId, { op: "quote", nodeId: "n1" })).json.quote;
    const q2 = (await op(planId, { op: "quote", nodeId: "n1" })).json.quote;
    expect((await op(planId, { op: "bind", nodeId: "n1", quoteToken: q2.quoteToken })).status).toBe(200);
    expect((await op(planId, { op: "bind", nodeId: "n1", quoteToken: q2.quoteToken })).status).toBe(200);
    expect(await op(planId, { op: "bind", nodeId: "n1", quoteToken: q1.quoteToken })).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
    vi.setSystemTime(T0 + 90_001);
    expect(await op(planId, { op: "bind", nodeId: "n1", quoteToken: q2.quoteToken })).toMatchObject({ status: 410, json: { code: "EXPIRED" } });
  });

  it("an expired plan is 410 for its owner, 404 for another wallet (same as missing), through the 24h grace; 404 after", async () => {
    const planId = await approvedPlan();
    const missing = `plan_${"6".repeat(32)}`;
    vi.setSystemTime(T0 + 7 * 24 * 60 * MIN);
    expect(await get(planId)).toMatchObject({ status: 410, cache: "no-store", json: { ok: false, code: "EXPIRED" } });
    expect(await op(planId, { op: "quote", nodeId: "n1" })).toMatchObject({ status: 410, json: { code: "EXPIRED" } });
    const foreign = await get(planId, { wallet: OTHER_WALLET });
    expect(foreign).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
    expect(foreign.json).toEqual((await get(missing, { wallet: OTHER_WALLET })).json); // indistinguishable
    expect(await get(missing)).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
    vi.setSystemTime(T0 + 8 * 24 * 60 * MIN - 1);
    expect((await get(planId)).status).toBe(410);
    vi.setSystemTime(T0 + 8 * 24 * 60 * MIN);
    expect(await get(planId)).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
  });

  it("quote refusals are 422 QUOTE_REFUSED; unexpected failures are a generic 502 with no internal detail", async () => {
    const planId = await approvedPlan();
    ctl.policy = { allowed: false, reason: "Blocked recipient." };
    expect(await op(planId, { op: "quote", nodeId: "n1" })).toMatchObject({ status: 422, json: { ok: false, code: "QUOTE_REFUSED", message: "Blocked recipient." } });
    ctl.policy = null;
    ctl.quoteThrows = "internal";
    const r = await op(planId, { op: "quote", nodeId: "n1" });
    expect(r).toMatchObject({ status: 502, cache: "no-store", json: { ok: false, code: "INTERNAL_ERROR" } });
    expect(r.text).not.toContain("engine down");
    expect(r.text).not.toContain("secret-internal-detail");
  });

  it("transaction mismatch: no build record is 404, a second hash is 409; a repeat is idempotent", async () => {
    const planId = await approvedPlan();
    const q = (await op(planId, { op: "quote", nodeId: "n1" })).json.quote;
    const tx = txHash();
    expect(await op(planId, { op: "tx", nodeId: "n1", quoteId: q.quoteId, txHash: tx })).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
    await seedBuild(q.quoteId, S, OTHER_WALLET);
    expect(await op(planId, { op: "tx", nodeId: "n1", quoteId: q.quoteId, txHash: tx })).toMatchObject({ status: 404 });
    // Quote 1 now has a fresh build and no transaction: a new quote is held
    // back by the pending-build guard until its 2-minute window passes.
    expect(await op(planId, { op: "quote", nodeId: "n1" })).toMatchObject({ status: 409, json: { code: "STEP_NOT_READY" } });
    vi.setSystemTime(T0 + 2 * MIN);
    const q2 = (await op(planId, { op: "quote", nodeId: "n1" })).json.quote;
    await seedBuild(q2.quoteId, S);
    expect((await op(planId, { op: "tx", nodeId: "n1", quoteId: q2.quoteId, txHash: tx })).status).toBe(200);
    expect((await op(planId, { op: "tx", nodeId: "n1", quoteId: q2.quoteId, txHash: tx })).status).toBe(200);
    expect(await op(planId, { op: "tx", nodeId: "n1", quoteId: q2.quoteId, txHash: txHash() })).toMatchObject({ status: 409, json: { code: "CONFLICT" } });
  });
});

/* ══ Settlement ═════════════════════════════════════════════════════════ */

describe("settlement through the API", () => {
  async function submitted() {
    const planId = await approvedPlan();
    const q = (await op(planId, { op: "quote", nodeId: "n1" })).json.quote;
    await seedBuild(q.quoteId, S);
    const tx = txHash();
    await op(planId, { op: "tx", nodeId: "n1", quoteId: q.quoteId, txHash: tx });
    return { planId, q, tx };
  }

  it("no confirmation verdict yet → 202 SETTLEMENT_PENDING (no-store), nothing recorded", async () => {
    const { planId } = await submitted();
    expect(await op(planId, { op: "settle", nodeId: "n1" })).toMatchObject({ status: 202, cache: "no-store", json: { ok: false, code: "SETTLEMENT_PENDING" } });
    expect((await get(planId)).json.plan.nodes[0].result).toBeNull();
  });

  it("a success verdict alone can't fabricate confirmation; injected status/outputs in the body are ignored", async () => {
    const { planId, tx } = await submitted();
    await seedVerdict(tx, OK_VERDICT);
    const r = await op(planId, { op: "settle", nodeId: "n1", status: "confirmed", outputs: SWAP_OUTPUTS, success: true, verified: true });
    expect(r).toMatchObject({ status: 200, json: { plan: { nodes: [{ state: "unverified", result: { status: "unverified", outputs: null } }, { state: "skipped" }] } } });
  });

  it("an action without confirmedOutputs can never become confirmed", async () => {
    const planId = await approvedPlan(singleDraft());
    const { settled } = await runStep(planId, "n1", T, { outputs: null });
    expect(settled.json.plan.nodes[0]).toMatchObject({ state: "unverified", result: { status: "unverified", outputs: null } });
  });

  it("confirmed only with the quote-bound output record; settle replay is idempotent", async () => {
    const { planId, q, tx } = await submitted();
    await seedVerdict(tx, OK_VERDICT);
    await seedOutputs(q.quoteId, tx, S, SWAP_OUTPUTS);
    const a = await op(planId, { op: "settle", nodeId: "n1" });
    expect(a.json.plan.nodes[0]).toMatchObject({ state: "confirmed", result: { status: "confirmed", outputs: SWAP_OUTPUTS } });
    expect((await op(planId, { op: "settle", nodeId: "n1" })).json).toEqual(a.json);
  });
});

/* ══ Errors ═════════════════════════════════════════════════════════════ */

describe("error mapping", () => {
  it("the approved PlanErrorCode → HTTP mapping, for every code", async () => {
    const { PLAN_ERROR_STATUS, planErrorResponse } = await import("@/lib/plan/http");
    const { PlanError } = await import("@/lib/plan/errors");
    expect(PLAN_ERROR_STATUS).toMatchObject({
      NOT_FOUND: 404, WALLET_MISMATCH: 404, CONFLICT: 409, NOT_APPROVABLE: 409, NOT_APPROVED: 409, STEP_NOT_READY: 409,
      EXPIRED: 410, QUOTE_REFUSED: 422, SETTLEMENT_PENDING: 202, CORRUPT: 500, UNAVAILABLE: 503,
      INVALID_PLAN: 400, INVALID_NODE: 400, UNVALIDATED_GRAPH: 400, RECIPIENT_UNRESOLVED: 400,
    });
    const corrupt = planErrorResponse(new PlanError("CORRUPT", "stored record at veripay:plan:x has bad graphHash"));
    expect(corrupt.status).toBe(500);
    const body = await corrupt.json();
    expect(body).toEqual({ ok: false, code: "CORRUPT", message: "This plan can't be loaded. Start a new plan." });
    expect(corrupt.headers.get("cache-control")).toBe("no-store");
    const odd = planErrorResponse(new TypeError("Cannot read properties of undefined (reading 'x') at /srv/app"));
    expect(odd.status).toBe(502);
    expect(JSON.stringify(await odd.json())).not.toContain("/srv/app");
  });

  it("a corrupt stored plan is a generic 500 through the route", async () => {
    const planId = await approvedPlan();
    const { planKeys, __putRawForTests } = await import("@/lib/plan/store");
    __putRawForTests(planKeys.core(planId), "{oops");
    const r = await get(planId);
    expect(r).toMatchObject({ status: 500, cache: "no-store", json: { ok: false, code: "CORRUPT", message: "This plan can't be loaded. Start a new plan." } });
  });

  it("production without KV is 503 UNAVAILABLE", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SESSION_SECRET", "test-only-production-secret");
    const r = await create(sendDraft());
    expect(r).toMatchObject({ status: 503, cache: "no-store", json: { ok: false, code: "UNAVAILABLE" } });
  });
});

/* ══ One error boundary per request ═════════════════════════════════════ */

describe("failures before the service are still the API's generic 502 (no-store)", () => {
  async function everyEndpoint(planId: string, o?: Opts) {
    return [
      await list(o), await create(sendDraft("intent_api_eb001"), o), await get(planId, o),
      await op(planId, { op: "next" }, o), await op(planId, { op: "quote", nodeId: "n1" }, o),
    ];
  }
  const generic = { status: 502, cache: "no-store", json: { ok: false, code: "INTERNAL_ERROR", message: "Plans are temporarily unavailable. Try again in a moment." } };

  it("the IP limiter throwing (KV/network failure) → generic 502, no internal detail", async () => {
    const planId = await approvedPlan();
    ctl.limiterThrows = "ip";
    for (const r of await everyEndpoint(planId)) {
      expect(r).toMatchObject(generic);
      expect(r.text).not.toContain("ECONNRESET");
      expect(r.text).not.toContain("redis-internal");
    }
  });

  it("the per-wallet limiter throwing → generic 502, no internal detail", async () => {
    const planId = await approvedPlan();
    ctl.limiterThrows = "wallet";
    for (const r of await everyEndpoint(planId)) {
      expect(r).toMatchObject(generic);
      expect(r.text).not.toContain("ECONNRESET");
    }
  });

  it("grant decoding throwing → generic 502, no internal detail", async () => {
    const planId = await approvedPlan();
    ctl.grantThrows = true;
    for (const r of await everyEndpoint(planId)) {
      expect(r).toMatchObject(generic);
      expect(r.text).not.toContain("keyring");
      expect(r.text).not.toContain("/etc/secrets");
    }
  });

  it("production without AUTH_SESSION_SECRET fails CLOSED: the grant can't be verified, so 401 (no-store)", async () => {
    const planId = await approvedPlan();
    const cookie = await cookieFor(WALLET); // well-formed, but unverifiable without the secret
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SESSION_SECRET", "");
    for (const r of await everyEndpoint(planId, { cookie })) {
      expect(r).toMatchObject({ status: 401, cache: "no-store", json: { ok: false, code: "wallet_grant_required" } });
    }
  });

  it("expected 401 and 429 are unchanged by the wider boundary", async () => {
    expect(await list({ wallet: null })).toMatchObject({ status: 401, cache: "no-store", json: { ok: false, code: "wallet_grant_required" } });
    for (let i = 0; i < 120; i++) await list({ wallet: null, ip: "203.0.113.250" });
    const ipLimited = await list({ wallet: null, ip: "203.0.113.250" });
    expect(ipLimited).toMatchObject({ status: 429, cache: "no-store" });
    const { GET } = await collection();
    for (let i = 0; i < 60; i++) await GET(await request("GET", "/api/plans", undefined, { ip: `192.0.2.${i}` }));
    const res = await GET(await request("GET", "/api/plans", undefined, { ip: "192.0.2.200" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

/* ══ Rate limits ════════════════════════════════════════════════════════ */

describe("rate limits (existing limiter: IP first, then per wallet)", () => {
  it("create: 10 per 5 minutes per wallet; another wallet is unaffected; 429 is no-store", async () => {
    for (let i = 0; i < 10; i++) expect((await create(sendDraft(`intent_api_rl${String(i).padStart(4, "0")}`))).status).toBe(200);
    const limited = await create(sendDraft("intent_api_rl9999"));
    expect(limited).toMatchObject({ status: 429, cache: "no-store" });
    expect((await create(sendDraft("intent_api_rlothr", OTHER_WALLET), { wallet: OTHER_WALLET })).status).toBe(200);
    vi.setSystemTime(T0 + 5 * MIN + 1);
    (globalThis as unknown as { __veripayRL?: Map<string, { resetAt: number }> }).__veripayRL?.forEach((e) => { e.resetAt = 0; });
    expect((await create(sendDraft("intent_api_rlaftr"))).status).toBe(200);
  });

  it.each([
    ["quote", 20, { op: "quote", nodeId: "n9" }],
    ["bind", 30, { op: "bind", nodeId: "n9", quoteToken: "t" }],
    ["tx", 30, { op: "tx", nodeId: "n9", quoteId: "a".repeat(32), txHash: `0x${"1".repeat(64)}` }],
    ["settle", 60, { op: "settle", nodeId: "n9" }],
    ["next (read)", 60, { op: "next" }],
  ])("%s: %i per minute per wallet", async (_l, max, body) => {
    const planId = await approvedPlan();
    for (let i = 0; i < (max as number); i++) expect((await op(planId, body, { ip: `198.51.100.${i % 50}` })).status).not.toBe(429);
    expect((await op(planId, body, { ip: "198.51.100.99" })).status).toBe(429);
    expect((await op(planId, body, { ip: "198.51.100.98", wallet: OTHER_WALLET })).status).not.toBe(429);
  });

  it("list/get share the read budget (60/min per wallet)", async () => {
    const planId = await approvedPlan();
    for (let i = 0; i < 30; i++) { await list({ ip: `192.0.2.${i}` }); await get(planId, { ip: `192.0.2.${100 + i}` }); }
    expect((await list({ ip: "192.0.2.250" })).status).toBe(429);
  });

  it("the IP limit applies first — even to unauthenticated requests", async () => {
    for (let i = 0; i < 120; i++) expect((await list({ wallet: null, ip: "203.0.113.200" })).status).toBe(401);
    expect(await list({ wallet: null, ip: "203.0.113.200" })).toMatchObject({ status: 429, cache: "no-store" });
    expect((await list({ ip: "203.0.113.201" })).status).toBe(200);
  });
});

/* ══ Boundary hygiene ═══════════════════════════════════════════════════ */

describe("the HTTP layer stays thin", () => {
  it("routes never hand the request, cookies or a client wallet to the service, and carry no plan rules", () => {
    for (const f of ["app/api/plans/route.ts", "app/api/plans/[planId]/route.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/svc\.\w+\(\s*req|listPlans\(\s*req|createPlan\(\s*req|getPlan\(\s*req/);
      for (const bad of ["searchParams", "body.wallet", "x-merchant-key", "resolveTenantId", "loadPlan", "@/lib/plan/store", "derivePlanState", "QUOTE_MAX_AGE_MS", "peekRequest", "readOutputRecord"]) {
        expect(src.includes(bad), `${f} contains ${bad}`).toBe(false);
      }
    }
    const http = readFileSync(join(process.cwd(), "lib/plan/http.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const bad of ["x-merchant-key", "resolveTenantId", "searchParams", "signTransaction", "sendTransaction", "createWalletClient", "fetch("]) {
      expect(http.includes(bad), `http.ts contains ${bad}`).toBe(false);
    }
  });
});
