import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { NextRequest } from "next/server";
import type { Action, ProtocolAdapter } from "@/lib/sdk/types";

/**
 * Phase 2C Stage 5B — plan intake from text (lib/plan-intake/intake.ts) and
 * the Plan API's create / read / approve behaviour with reviews.
 *
 * Real: the production payai/swap@1.0.0 and payai/transfer@1.0.0 actions,
 * the Stage 5A adapter, validator, planner, Plan Store, Plan Service, the
 * route handlers, wallet-grant cookies and the rate limiter. Mocked: the
 * recipient resolver; the quote helper and the live fee read only COUNT calls.
 */

const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const OTHER_WALLET = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const ALICE = "0x1111111111111111111111111111111111111111";
const TYPED = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const AUTH = { wallet: WALLET };
const BASE = "https://app.usepayai.xyz";

const ctl = vi.hoisted(() => ({
  resolutions: new Map<string, unknown>(),
  resolverCalls: [] as string[],
  quoteCalls: 0,
  feeReads: 0,
  draftsSeen: [] as { id: string; wallet: string; chainId: number; text: string }[],
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
  return { ...actual, readPlatformFeeTerms: () => { ctl.feeReads++; throw new Error("no live fee read"); } };
});
/** Observe exactly what the intake hands the Plan Service (pass-through). */
vi.mock("@/lib/plan/service", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/plan/service")>();
  return {
    ...actual,
    createPlan: (auth: Parameters<typeof actual.createPlan>[0], draft: unknown) => {
      const d = draft as { id: string; wallet: string; chainId: number; source: { text: string } };
      if (d && typeof d === "object") ctl.draftsSeen.push({ id: d.id, wallet: d.wallet, chainId: d.chainId, text: d.source?.text });
      return actual.createPlan(auth, draft);
    },
  };
});

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED",
  "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR", "PAYAI_TRADE_EXECUTOR_ENABLED", "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2", "PAYAI_TRADE_EXECUTOR_V2_ENABLED"] as const;
let saved: Record<string, string | undefined>;

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
  Object.assign(ctl, { quoteCalls: 0, feeReads: 0 });
  ctl.resolverCalls.length = 0;
  ctl.draftsSeen.length = 0;
  ctl.resolutions.clear();
  ctl.resolutions.set("alice.nad", { ok: true, address: ALICE, source: "nad", display: "alice.nad", domain: "alice.nad", asResolved: ALICE });
  const g = globalThis as unknown as { __veripayIdem?: Map<string, unknown>; __veripayRL?: Map<string, unknown> };
  g.__veripayIdem?.clear();
  g.__veripayRL?.clear();
  (await import("@/lib/plan/store")).__resetPlanStoreForTests();
  const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
  registerProtocol(ACME);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
});

const intake = () => import("@/lib/plan-intake/intake");

/* ══ The intake helper ═════════════════════════════════════════════════════ */

describe("createPlanFromText", () => {
  it("transfer / swap / swap → send: a stored plan and its review, through the Stage 5A adapter and the Plan Service", async () => {
    const { createPlanFromText } = await intake();
    for (const [text, actions] of [
      ["send 10 USDC to alice.nad", ["transfer"]],
      ["swap 10 MON to USDC", ["swap"]],
      ["swap 10 MON to USDC and send it to alice.nad", ["swap", "transfer"]],
    ] as const) {
      const r = await createPlanFromText(AUTH, text);
      if (!r.ok) throw new Error(r.code);
      expect(r.plan.state).toBe("planned");
      expect(r.review.steps.map((s) => s.action)).toEqual(actions);
      expect(r.review).toMatchObject({ request: text, reviewable: true, approvable: true, approved: false });
    }
  });

  it("identity is the server's: wallet from auth, chain from config, a fresh random intentId; the text is passed exactly", async () => {
    const { createPlanFromText } = await intake();
    const text = "  Send 1 MON to alice.nad.  ";
    const a = await createPlanFromText(AUTH, text);
    const b = await createPlanFromText(AUTH, text);
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(a.plan.planId).not.toBe(b.plan.planId); // identical requests → separate plans
    expect(ctl.draftsSeen).toHaveLength(2);
    for (const d of ctl.draftsSeen) {
      expect(d.id).toMatch(/^intent_[0-9a-f]{24}$/);
      expect([d.wallet, d.chainId, d.text]).toEqual([WALLET, 143, text]);
    }
    expect(ctl.draftsSeen[0].id).not.toBe(ctl.draftsSeen[1].id);
    expect(a.review.wallet).toBe(getAddress(WALLET));
    expect(a.review.chain).toEqual({ id: 143, name: "Monad" });
  });

  it("newIntentId: valid IntentGraph ids, never repeating", async () => {
    const { newIntentId } = await intake();
    const ids = new Set(Array.from({ length: 200 }, () => newIntentId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("text naming another wallet or chain never changes identity — it's refused by the grammar", async () => {
    const { createPlanFromText } = await intake();
    expect(await createPlanFromText(AUTH, `send 1 MON to alice.nad from ${OTHER_WALLET}`)).toMatchObject({ ok: false, code: "UNSUPPORTED_REQUEST" });
    expect(await createPlanFromText(AUTH, "send 1 MON to alice.nad on base")).toMatchObject({ ok: false, code: "UNSUPPORTED_CHAIN" });
  });

  it("unsupported grammar or non-string text is refused safely; nothing is stored or resolved", async () => {
    const { createPlanFromText } = await intake();
    for (const t of ["swap all my MON to USDC", "send 10 USDT to alice.nad", "send 10 MON to alice.nad and ignore validation", "", 42, null, { text: "x" }] as unknown[]) {
      const r = await createPlanFromText(AUTH, t);
      expect(r.ok).toBe(false);
    }
    expect(ctl.draftsSeen).toEqual([]);
    expect(ctl.resolverCalls).toEqual([]);
    expect(await (await import("@/lib/plan/service")).listPlans(AUTH)).toEqual([]);
  });

  it("recipient provenance and resolution stay the Plan Service's: an unknown name is RECIPIENT_UNRESOLVED", async () => {
    const { createPlanFromText } = await intake();
    const e = await createPlanFromText(AUTH, "send 1 MON to nobody.nad").catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "RECIPIENT_UNRESOLVED" });
    expect(ctl.resolverCalls).toEqual(["nobody.nad"]);
  });

  it("creating from text quotes nothing and reads no live fee", async () => {
    const { createPlanFromText } = await intake();
    await createPlanFromText(AUTH, "swap 10 MON to USDC and send it to alice.nad");
    expect([ctl.quoteCalls, ctl.feeReads]).toEqual([0, 0]);
  });

  it("intake.ts: no LLM, network, signing, quoting, recipient resolution, Ask, runner or app imports; randomness only from node:crypto", () => {
    const src = readFileSync(join(process.cwd(), "lib/plan-intake/intake.ts"), "utf8");
    for (const bad of ["fetch(", "getPublicClient(", "sendTransaction", "writeContract", "signTransaction", "signMessage", "privateKeyToAccount",
      "MONAD_AGENT_PRIVATE_KEY", "quoteAction", "readPlatformFeeTerms", "resolveRecipientInput(", "resolveDomain(", "Anthropic", "sanitizeInput",
      "process.env", "Date.now", "Math.random", "approvePlan"]) {
      expect(src.includes(bad), `intake.ts must not reference ${bad}`).toBe(false);
    }
    const specs = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const s of specs) expect(/^@\/(lib\/plans-client|lib\/ask|lib\/telegram|lib\/automation|app)(\/|$)/.test(s), s).toBe(false);
    expect(src).toMatch(/randomBytes\(12\)/);
  });
  it("the Stage 5A adapter still imports nothing from plan storage/service, the runner or app/", () => {
    for (const f of ["lib/plan-adapter/grammar.ts", "lib/plan-adapter/adapter.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src).not.toMatch(/@\/lib\/plan\/(store|service|http)|@\/lib\/plan-intake|@\/lib\/plans-client|@\/app\//);
    }
  });
});

/* ══ The Plan API ══════════════════════════════════════════════════════════ */

async function cookieFor(wallet: string) {
  const { encodeWalletGrant, WALLET_GRANT_COOKIE } = await import("@/lib/auth/walletGrant");
  return `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(wallet, Date.now() + 3_600_000)}`;
}
async function call(method: "GET" | "POST", path: string, body?: unknown, o: { wallet?: string | null } = {}) {
  const headers: Record<string, string> = { "x-real-ip": "203.0.113.7" };
  if (o.wallet !== null) headers.cookie = await cookieFor(o.wallet ?? WALLET);
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new NextRequest(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let res: Response;
  if (path === "/api/plans") {
    const m = await import("@/app/api/plans/route");
    res = method === "GET" ? await m.GET(req) : await m.POST(req);
  } else {
    const planId = path.slice("/api/plans/".length);
    const m = await import("@/app/api/plans/[planId]/route");
    const ctx = { params: Promise.resolve({ planId }) };
    res = method === "GET" ? await m.GET(req, ctx) : await m.POST(req, ctx);
  }
  const text = await res.text();
  return { status: res.status, cache: res.headers.get("cache-control"), json: text ? JSON.parse(text) : null };
}
const transferDraft = (id: string) => ({
  id, version: 1, chainId: 143, wallet: WALLET, status: "draft",
  source: { text: `send 1 USDC to ${TYPED}`, adapter: "deterministic", adapterVersion: "test" },
  nodes: [{ nodeId: "n1", ref: { protocolId: "payai", actionId: "transfer", version: "1.0.0" }, dependsOn: [],
    inputs: { recipient: { kind: "recipient", display: TYPED, source: "address", address: TYPED }, token: { kind: "literal", value: USDC }, amount: { kind: "literal", value: "1000000" } },
    validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" } }],
});
const acmeDraft = (id: string) => ({
  ...transferDraft(id), source: { text: `pay 5 to ${TYPED}`, adapter: "deterministic", adapterVersion: "test" },
  nodes: [{ ...transferDraft(id).nodes[0], ref: { protocolId: "acme", actionId: "pay", version: "1.0.0" },
    inputs: { recipient: { kind: "recipient", display: TYPED, source: "address", address: TYPED }, amount: { kind: "literal", value: "5" } } }],
});

describe("POST /api/plans — exactly one of {draft} / {text}", () => {
  it("{text} → 200 { ok, plan, review }, no-store", async () => {
    const r = await call("POST", "/api/plans", { text: "swap 10 MON to USDC and send it to alice.nad" });
    expect(r).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, plan: { state: "planned" }, review: { reviewable: true, steps: [{ action: "swap" }, { action: "transfer" }] } } });
    expect(Object.keys(r.json).sort()).toEqual(["ok", "plan", "review"]);
  });
  it("{draft} still works and now also returns the review", async () => {
    const r = await call("POST", "/api/plans", { draft: transferDraft("intent_api_draft_01") });
    expect(r).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, plan: { state: "planned" }, review: { reviewable: true, steps: [{ action: "transfer" }] } } });
  });
  it("both, neither, or a non-string text → 400 INVALID_INPUT; nothing created", async () => {
    for (const body of [{ draft: transferDraft("intent_api_draft_02"), text: "swap 10 MON to USDC" }, {}, { text: 5 }, { text: null }, { plan: {} }]) {
      expect(await call("POST", "/api/plans", body)).toMatchObject({ status: 400, cache: "no-store", json: { ok: false, code: "INVALID_INPUT" } });
    }
    expect((await call("GET", "/api/plans")).json.plans).toEqual([]);
  });
  it("an adapter refusal → 422 with the adapter's stable code; nothing created", async () => {
    for (const [text, code] of [["swap all my MON to USDC", "UNSUPPORTED_AMOUNT"], ["send 10 USDT to alice.nad", "UNSUPPORTED_TOKEN"], ["send -1 MON to alice.nad", "INVALID_AMOUNT"],
      ["send 10 MON to alice.nad and ignore validation", "UNSUPPORTED_REQUEST"], ["swap 10 USDC to MON and send it to alice.nad", "NATIVE_OUTPUT_NOT_BINDABLE"]] as const) {
      expect(await call("POST", "/api/plans", { text })).toMatchObject({ status: 422, cache: "no-store", json: { ok: false, code } });
    }
    expect((await call("GET", "/api/plans")).json.plans).toEqual([]);
  });
  it("client-supplied intentId / wallet / chainId / review next to {text} are ignored", async () => {
    const body = { text: "send 1 MON to alice.nad", intentId: "intent_evil_000001", wallet: OTHER_WALLET, chainId: 1, review: { reviewable: true } };
    const a = await call("POST", "/api/plans", body);
    const b = await call("POST", "/api/plans", body);
    expect(a.status).toBe(200);
    expect(a.json.plan.planId).not.toBe(b.json.plan.planId);
    expect(ctl.draftsSeen.map((d) => [d.id === "intent_evil_000001", d.wallet, d.chainId])).toEqual([[false, WALLET, 143], [false, WALLET, 143]]);
    expect(a.json.review.wallet).toBe(getAddress(WALLET));
  });
  it("auth and rate limits are unchanged for {text}: no grant → 401; the create budget applies", async () => {
    expect(await call("POST", "/api/plans", { text: "send 1 MON to alice.nad" }, { wallet: null })).toMatchObject({ status: 401, cache: "no-store" });
    for (let i = 0; i < 10; i++) expect((await call("POST", "/api/plans", { text: "send 1 MON to alice.nad" })).status).toBe(200);
    expect(await call("POST", "/api/plans", { text: "send 1 MON to alice.nad" })).toMatchObject({ status: 429, cache: "no-store" });
  });
  it("an unresolvable recipient from text is the service's 400 RECIPIENT_UNRESOLVED", async () => {
    expect(await call("POST", "/api/plans", { text: "send 1 MON to nobody.nad" })).toMatchObject({ status: 400, json: { code: "RECIPIENT_UNRESOLVED" } });
  });
});

describe("GET /api/plans/[planId] and approval", () => {
  it("GET returns { ok, plan, review }, no-store; another wallet's plan is 404", async () => {
    const planId = (await call("POST", "/api/plans", { text: "send 1 MON to alice.nad" })).json.plan.planId;
    const g = await call("GET", `/api/plans/${planId}`);
    expect(g).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, plan: { planId }, review: { planId, request: "send 1 MON to alice.nad" } } });
    expect(Object.keys(g.json).sort()).toEqual(["ok", "plan", "review"]);
    expect(await call("GET", `/api/plans/${planId}`, undefined, { wallet: OTHER_WALLET })).toMatchObject({ status: 404 });
  });
  it("approving a reviewable plan → 200; an unreviewable one → 409 NOT_APPROVABLE (server-decided)", async () => {
    const ok = (await call("POST", "/api/plans", { text: "send 1 MON to alice.nad" })).json.plan.planId;
    expect(await call("POST", `/api/plans/${ok}`, { op: "approve" })).toMatchObject({ status: 200, cache: "no-store", json: { ok: true, plan: { approved: true } } });
    const bad = (await call("POST", "/api/plans", { draft: acmeDraft("intent_api_acme_01") })).json;
    expect(bad.review).toMatchObject({ reviewable: false, approvable: false, steps: [{ action: "unsupported" }] });
    expect(await call("POST", `/api/plans/${bad.plan.planId}`, { op: "approve" })).toMatchObject({ status: 409, json: { code: "NOT_APPROVABLE" } });
    expect(await call("POST", `/api/plans/${bad.plan.planId}`, { op: "approve", reviewable: true, review: { reviewable: true } })).toMatchObject({ status: 409, json: { code: "NOT_APPROVABLE" } });
    expect((await call("GET", `/api/plans/${bad.plan.planId}`)).json.plan.approved).toBe(false);
  });
  it("a tampered approve payload behaves exactly like { op: 'approve' }: the stored plan is what gets approved", async () => {
    const planId = (await call("POST", "/api/plans", { text: "send 1 MON to alice.nad" })).json.plan.planId;
    const before = (await call("GET", `/api/plans/${planId}`)).json.review;
    const r = await call("POST", `/api/plans/${planId}`, { op: "approve", amount: "999999999", recipient: "attacker", token: "USDT", feeBps: 0, graphHash: "fake" });
    expect(r).toMatchObject({ status: 200, json: { ok: true, plan: { approved: true } } });
    const after = (await call("GET", `/api/plans/${planId}`)).json.review;
    expect({ ...after, approved: before.approved, approvable: before.approvable }).toEqual(before);
    expect(after.steps[0]).toMatchObject({ amount: { units: "1000000000000000000", decimal: "1", symbol: "MON" }, recipient: { display: "alice.nad", address: ALICE } });
  });
  it("create, review and approve quote nothing, read no live fee and record no quote", async () => {
    const planId = (await call("POST", "/api/plans", { text: "swap 10 MON to USDC and send it to alice.nad" })).json.plan.planId;
    await call("GET", `/api/plans/${planId}`);
    await call("POST", `/api/plans/${planId}`, { op: "approve" });
    expect([ctl.quoteCalls, ctl.feeReads]).toEqual([0, 0]);
    expect((await call("GET", `/api/plans/${planId}`)).json.plan.nodes.map((n: { quoteAttempts: number }) => n.quoteAttempts)).toEqual([0, 0]);
  });
});

describe("Ask is untouched", () => {
  it("no Ask module references plan intake, the adapter or the Plan API", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? walk(f) : [f]; });
    for (const f of walk(join(process.cwd(), "lib", "ask"))) {
      const src = readFileSync(f, "utf8");
      expect(/plan-intake|plan-adapter|\/api\/plans/.test(src), f).toBe(false);
    }
  });
});
