import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * PayAI Rooms — the HTTP boundary (app/api/rooms/**). Real: the routes, the
 * wallet-grant cookie, the rate limiter, the room service and store.
 * Mocked: plan intake / Plan Service (nothing executes) and the resolver.
 */

const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const ME = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const YOU = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const BASE = "https://app.usepayai.xyz";

const ctl = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("@/lib/plan-intake/intake", () => ({
  createPlanFromText: async (_auth: unknown, text: string) => { ctl.texts.push(text); return { ok: true, plan: { planId: `plan_${"1".repeat(32)}` }, review: { steps: [] } }; },
}));
vi.mock("@/lib/plan/service", () => ({
  getPlan: async () => { throw Object.assign(new Error("nf"), { code: "NOT_FOUND" }); },
  getPlanWithReview: async () => ({ plan: {}, review: {} }),
}));
vi.mock("@/lib/payees/resolve", () => ({ resolveRecipientInput: async (i: string) => ({ ok: false, message: `"${i}" isn't resolvable here.` }) }));

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC"] as const;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  (await import("@/lib/rooms/store")).__resetRoomsForTests();
  (globalThis as unknown as { __veripayRL?: Map<string, unknown> }).__veripayRL?.clear();
  ctl.texts.length = 0;
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function req(path: string, o: { method?: string; body?: unknown; wallet?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.wallet !== null) {
    const { encodeWalletGrant, WALLET_GRANT_COOKIE } = await import("@/lib/auth/walletGrant");
    headers.cookie = `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(o.wallet ?? ME, Date.now() + 3_600_000)}`;
  }
  return new NextRequest(`${BASE}${path}`, { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
const list = () => import("@/app/api/rooms/route");
const one = () => import("@/app/api/rooms/[id]/route");
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function created(text = "a room for 100 USDC for 5 people") {
  const res = await (await list()).POST(await req("/api/rooms", { method: "POST", body: { op: "create", text, memo: "Dinner" } }));
  expect(res.status).toBe(200);
  return (await res.json()).room.id as string;
}

describe("identity is the wallet grant — nothing else", () => {
  it("no grant → 401 on list, create, join, pay, confirm, cancel (no-store)", async () => {
    const id = await created();
    const r1 = await (await list()).GET(await req("/api/rooms", { wallet: null }));
    const r2 = await (await list()).POST(await req("/api/rooms", { method: "POST", wallet: null, body: { op: "create", text: "100 USDC for 5 people" } }));
    expect([r1.status, r2.status]).toEqual([401, 401]);
    for (const op of ["join", "pay", "confirm", "cancel"]) {
      const r = await (await one()).POST(await req(`/api/rooms/${id}`, { method: "POST", wallet: null, body: { op } }), params(id));
      expect(r.status, op).toBe(401);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("a forged grant is 401", async () => {
    const r = await (await list()).GET(new NextRequest(`${BASE}/api/rooms`, { headers: { cookie: "payai_wallet_grant=forged.value" } }));
    expect(r.status).toBe(401);
  });

  it("a wallet, plan id, amount or recipient in the body changes nothing", async () => {
    const id = await created();
    const join = await (await one()).POST(await req(`/api/rooms/${id}`, { method: "POST", wallet: YOU, body: { op: "join", wallet: ME, address: ME } }), params(id));
    expect(join.status).toBe(200);
    const pay = await (await one()).POST(await req(`/api/rooms/${id}`, { method: "POST", wallet: YOU, body: { op: "pay", amount: "1", recipient: YOU, planId: "plan_x" } }), params(id));
    expect(pay.status).toBe(200);
    expect(ctl.texts).toEqual([`send 20 USDC to ${(await import("viem")).getAddress(ME)}`]);
    // ME (the creator & recipient) never became a participant through YOU's body.
    const view = await (await (await one()).GET(await req(`/api/rooms/${id}`, { wallet: ME }), params(id))).json();
    expect(view.room.joined).toBe(1);
    expect(view.room.viewer.slot).toBeNull();
  });
});

describe("reading a room", () => {
  it("anyone with the link can read it — terms and counts, no participant address", async () => {
    const id = await created();
    await (await one()).POST(await req(`/api/rooms/${id}`, { method: "POST", wallet: YOU, body: { op: "join" } }), params(id));
    const r = await (await one()).GET(await req(`/api/rooms/${id}`, { wallet: null }), params(id));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.room).toMatchObject({ total: "100", share: "20", target: 5, joined: 1, viewer: { signedIn: false, canJoin: false } });
    expect(JSON.stringify(body).toLowerCase()).not.toContain(YOU.slice(2));
  });

  it("an unknown or malformed id is 404", async () => {
    for (const id of ["room_000000000000000000000000", "nope", "room_%2e%2e"]) {
      expect((await (await one()).GET(await req(`/api/rooms/${id}`), params(id))).status, id).toBe(404);
    }
  });

  it("the list is the caller's own", async () => {
    await created();
    const mine = await (await (await list()).GET(await req("/api/rooms"))).json();
    const theirs = await (await (await list()).GET(await req("/api/rooms", { wallet: YOU }))).json();
    expect(mine.rooms).toHaveLength(1);
    expect(theirs.rooms).toHaveLength(0);
  });
});

describe("input and errors", () => {
  it("unknown ops, bad JSON and oversized bodies are 400", async () => {
    const id = await created();
    expect((await (await one()).POST(await req(`/api/rooms/${id}`, { method: "POST", body: { op: "approve" } }), params(id))).status).toBe(400);
    expect((await (await list()).POST(await req("/api/rooms", { method: "POST", body: { op: "create" } }))).status).toBe(400);
    expect((await (await list()).POST(await req("/api/rooms", { method: "POST", body: { op: "create", text: "x".repeat(5000) } }))).status).toBe(400);
  });

  it("refusals carry the reason and a mapped status — never internals", async () => {
    const r = await (await list()).POST(await req("/api/rooms", { method: "POST", body: { op: "preview", text: "100 A-USDC for 5 people" } }));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ ok: false, code: "UNSUPPORTED_ASSET", message: expect.stringMatching(/Cleanverse/) });
    const s = await (await list()).POST(await req("/api/rooms", { method: "POST", body: { op: "preview", text: "100 USDC for 3 people" } }));
    expect(s.status).toBe(400);
  });

  it("preview stores nothing", async () => {
    const r = await (await list()).POST(await req("/api/rooms", { method: "POST", body: { op: "preview", text: "20 USDC each for 4 people" } }));
    expect(await r.json()).toMatchObject({ ok: true, preview: { total: "80", share: "20", participants: 4, verified: false, recipient: { isCreator: true } } });
    expect((await (await (await list()).GET(await req("/api/rooms"))).json()).rooms).toHaveLength(0);
  });

  it("creating is rate-limited per wallet (10 per 5 minutes)", async () => {
    for (let i = 0; i < 10; i++) await created();
    const r = await (await list()).POST(await req("/api/rooms", { method: "POST", body: { op: "create", text: "100 USDC for 5 people" } }));
    expect(r.status).toBe(429);
  });
});
