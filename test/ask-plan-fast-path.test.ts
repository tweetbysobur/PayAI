import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchPlanRequest, PLAN_FOUND_TEXT, PLAN_THINKING_LABEL } from "@/lib/ask/planFastPath";
import { feeEstimate } from "@/lib/ask/planCards";
import { createPlanForTurn } from "@/lib/ask/planTurn";
import { startAskTiming } from "@/lib/ask/timing";
import { createTiming } from "@/lib/platform/timing";
import { parseIntent } from "@/lib/plan-adapter/adapter";
import type { ApiFetch } from "@/lib/plans-client/api";

const A = "0x" + "ab".repeat(20);
const TOKENS = { monDecimals: 18, stable: { symbol: "USDC", decimals: 6 } };

describe("matchPlanRequest (client hint for the deterministic plan path)", () => {
  it.each([
    [`send 0.1 MON to ${A}`, "transfer"],
    ["Send 5 usdc to alice.nad", "transfer"],
    ["pay 2 MON to bob", "transfer"],
    ["send  1   MON  to alice.nad.", "transfer"],
    ["swap 5 USDC to MON", "swap"],
    ["swap 1 MON for USDC", "swap"],
    ["swap 1 MON to USDC and send it to alice.nad", "swap_send"],
    [`swap 1 MON to USDC, then send the USDC to ${A}`, "swap_send"],
  ])("%s → %s", (text, kind) => {
    expect(matchPlanRequest(text)).toBe(kind);
  });

  it.each([
    "",
    "send MON to alice.nad",
    "send all my MON to alice.nad",
    "send 0.1 MON to alice.nad tomorrow",
    "send 0.2 MON to A, 0.3 MON",            // a clause missing its recipient
    "send money to alice and bob",           // no amount, no token
    "send 0.2 to alice",                     // no token
    "swap 10 USDC",                          // no destination token
    "0.3 MON to bob",                        // a carried-over transfer needs a transfer before it
    "send it to bob",                        // a bound send needs a swap before it
    Array.from({ length: 501 }, (_, i) => `send 1 MON to a${i}`).join(", "), // past the resource ceiling
    "what is 0.1 MON worth",
    "send 01 MON to alice.nad",
    "send 1 MON to alice.nad every week",
    "x".repeat(501),
  ])("no hint for %j", (text) => {
    expect(matchPlanRequest(text)).toBeNull();
  });

  it("every shape it hints at is one the server's own grammar accepts", () => {
    for (const text of [
      `send 0.1 MON to ${A}`, "send 5 USDC to alice.nad", "pay 2 MON to bob",
      "swap 5 USDC to MON", "swap 1 MON to USDC and send it to alice.nad",
    ]) {
      expect(matchPlanRequest(text), text).not.toBeNull();
      expect(parseIntent(text, TOKENS).ok, text).toBe(true);
    }
  });

  it("copy: a found line and a working label per kind, no 'thinking' phrasing", () => {
    expect(PLAN_FOUND_TEXT.transfer).toBe("Here's your transfer.");
    for (const s of [...Object.values(PLAN_FOUND_TEXT), ...Object.values(PLAN_THINKING_LABEL)]) expect(s).not.toMatch(/thinking/i);
  });
});

describe("feeEstimate (fee on top; exact integer arithmetic like the contract)", () => {
  it("1 USDC at 25 bps: the contract's own fee on the total leaves exactly 1 USDC", () => {
    expect(feeEstimate("1", 6, 25)).toEqual({ fee: "0.002506", total: "1.002506" });
    // 1002506 − floor(1002506 × 25 / 10000) = 1000000; one unit less would net 999999.
  });
  it("0.1 MON at 25 bps", () => {
    const e = feeEstimate("0.1", 18, 25)!;
    const total = BigInt(e.total.replace(".", "").padEnd(19, "0")) ; // 0.xxx → 18 decimals
    expect(total - (total * 25n) / 10000n).toBe(100000000000000000n);
  });
  it("refuses what it can't read", () => {
    expect(feeEstimate("1e3", 18, 25)).toBeNull();
    expect(feeEstimate("-1", 18, 25)).toBeNull();
  });
});

describe("server timing (lib/platform/timing)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("sets Server-Timing and logs one line of phase names and durations only", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let t = 0;
    const timing = createTiming("plans.create", () => t);
    t = 12; timing.mark("auth");
    t = 40; timing.mark("plan");
    timing.mark("Bad Name"); // ignored
    const res = timing.finish({ headers: new Headers(), status: 200 }, { kind: "transfer", "bad key": 1 });
    expect(res.headers.get("Server-Timing")).toBe("auth;dur=12.0, plan;dur=28.0, total;dur=40.0");
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({ evt: "timing", route: "plans.create", status: 200, totalMs: 40, authMs: 12, planMs: 28, kind: "transfer" });
  });
});

describe("client timing (lib/ask/timing)", () => {
  it("records marks per turn in a bounded buffer, first mark wins", () => {
    const t = startAskTiming("plan");
    t.mark("intent_detected");
    t.mark("plan_created");
    t.mark("plan_created");
    const list = (globalThis as { __payaiAskTimings?: { path: string; marks: Record<string, number> }[] }).__payaiAskTimings!;
    const e = list[list.length - 1];
    expect(e.path).toBe("plan");
    expect(Object.keys(e.marks)).toEqual(["request_received", "intent_detected", "plan_created"]);
    for (let i = 0; i < 60; i++) startAskTiming("understand");
    expect(list.length).toBeLessThanOrEqual(50);
  });
});

/* ── createPlanForTurn: one plan per turn, even across retries ───────────── */

interface Call { method: string; url: string; body: unknown }

function fakeApi(opts: { createStatus?: number; plans?: unknown[] } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const plan = (id: string) => ({ planId: id, state: "planned", approved: false, abandoned: false, expired: false, approvable: true, nodes: [], recipients: {} });
  const review = (id: string) => ({ planId: id, request: "send 1 MON to alice.nad", steps: [], reviewable: true });
  const f: ApiFetch = async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, body });
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const json = (status: number, b: unknown) => ({ status, text: async () => JSON.stringify(b) });
    if (init.method === "GET" && url === "/api/plans") return json(200, { ok: true, plans: opts.plans ?? [] });
    if (init.method === "GET") { const id = decodeURIComponent(url.split("/").pop()!); return json(200, { ok: true, plan: plan(id), review: review(id) }); }
    if (url === "/api/plans") {
      const status = opts.createStatus ?? 200;
      const id = `plan_new${++n}`;
      return status === 200 ? json(200, { ok: true, plan: plan(id), review: review(id) }) : json(status, { ok: false, code: "UNSUPPORTED_REQUEST" });
    }
    return json(200, { ok: true });
  };
  return { f, calls };
}

const summary = (id: string, extra: Record<string, unknown> = {}) => ({
  planId: id, request: "send 1 MON to alice.nad", state: "planned", abandoned: false, inFlight: false, steps: 1, createdAt: Date.now(), ...extra,
});

describe("createPlanForTurn", () => {
  const TEXT = "send 1 MON to alice.nad";

  it("first attempt: one create, nothing else", async () => {
    const { f, calls } = fakeApi();
    const r = await createPlanForTurn(TEXT, { since: Date.now(), retry: false, fetch: f });
    expect(r.status).toBe(200);
    expect(r.data?.plan.planId).toBe("plan_new1");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/plans"]);
    expect(calls[0].body).toEqual({ text: TEXT });
  });

  it("refused by the adapter: no plan, status for the caller's fallback", async () => {
    const { f } = fakeApi({ createStatus: 422 });
    expect(await createPlanForTurn(TEXT, { since: Date.now(), retry: false, fetch: f })).toMatchObject({ data: null, status: 422, refusal: { code: "UNSUPPORTED_REQUEST" } });
  });

  it("aborted: no plan and no further request", async () => {
    const { f, calls } = fakeApi();
    const ac = new AbortController();
    ac.abort();
    expect(await createPlanForTurn(TEXT, { since: Date.now(), retry: false, fetch: f, signal: ac.signal })).toEqual({ data: null, status: 0 });
    expect(calls).toHaveLength(1);
  });

  it("retry reuses the plan the first attempt created — no second create", async () => {
    const { f, calls } = fakeApi({ plans: [summary("plan_first")] });
    const r = await createPlanForTurn(TEXT, { since: Date.now(), retry: true, fetch: f });
    expect(r.data?.plan.planId).toBe("plan_first");
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/plans")).toBe(false);
  });

  it("retry never reuses an approved, cancelled, in-flight, older or different plan", async () => {
    const { f, calls } = fakeApi({ plans: [
      summary("p_approved", { state: "approved" }), summary("p_cancel", { abandoned: true }), summary("p_flight", { inFlight: true }),
      summary("p_old", { createdAt: Date.now() - 600_000 }), summary("p_other", { request: "send 2 MON to alice.nad" }),
    ] });
    const r = await createPlanForTurn(TEXT, { since: Date.now(), retry: true, fetch: f });
    expect(r.data?.plan.planId).toBe("plan_new1");
    expect(calls.filter((c) => c.body && (c.body as { op?: string }).op === "abandon")).toEqual([]);
  });

  it("retry that creates cancels any other open plan from this turn, keeping exactly one", async () => {
    let listed = 0;
    const { f: base, calls } = fakeApi();
    // The first listing (before creating) sees nothing; the one after sees
    // the late plan from the aborted first attempt plus the new one.
    const f: ApiFetch = async (url, init) => {
      if (init.method === "GET" && url === "/api/plans") {
        listed += 1;
        calls.push({ method: "GET", url, body: undefined });
        const plans = listed === 1 ? [] : [summary("plan_new1"), summary("plan_late")];
        return { status: 200, text: async () => JSON.stringify({ ok: true, plans }) };
      }
      return base(url, init);
    };
    const r = await createPlanForTurn(TEXT, { since: Date.now(), retry: true, fetch: f });
    expect(r.data?.plan.planId).toBe("plan_new1");
    const abandons = calls.filter((c) => (c.body as { op?: string } | undefined)?.op === "abandon").map((c) => c.url);
    expect(abandons).toEqual(["/api/plans/plan_late"]);
  });
});

describe("source boundary: the fast path adds no execution path", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("Ask's plan modules only create / read / approve / cancel through the client API; the card runs only through runPlanInApp", () => {
    for (const f of ["lib/ask/planTurn.ts", "lib/ask/planCards.ts", "lib/ask/planFastPath.ts", "components/ask/PlanCard.tsx", "lib/ask/useAskChat.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/createPlanRunner|createHttpTransports|createLocalJournal|createWebExecutionLock/);
      expect(src, f).not.toMatch(/op:\s*["'](next|quote|bind|tx|intent|release|settle)["']/);
    }
    const card = read("components/ask/PlanCard.tsx");
    expect(card).toMatch(/runPlanInApp\(\{/);
    expect(card).not.toMatch(/\bsendTransaction\s*\(|\bwaitForReceipt\s*\(/);
    // Retry and the plan fast path never touch execution.
    const turn = read("lib/ask/planTurn.ts");
    expect(turn).not.toMatch(/approvePlan|runPlanInApp/);
  });
});
