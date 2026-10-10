import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";

/**
 * Escrow Rooms on a REAL KV — not the in-memory store.
 *
 * Runs only when ROOMS_KV_TEST_URL / ROOMS_KV_TEST_TOKEN point at a
 * non-production, Upstash-REST-compatible store (locally: redis-server behind
 * an Upstash REST shim). Skipped otherwise. Keys live under payai:rooms: with
 * random room ids.
 *
 * Real: the escrow store and service (confirmEscrowAction), @upstash/redis,
 * the KV adapter, and the escrow event DECODERS (receipts are built from real
 * ABI-encoded logs). Mocked: the Plan Service (no plan executes), the receipt
 * read and the escrow contract reads. NOT evidence of on-chain behaviour.
 */

const URL_ = process.env.ROOMS_KV_TEST_URL;
const TOKEN = process.env.ROOMS_KV_TEST_TOKEN;
const run = URL_ && TOKEN ? describe : describe.skip;

const ESCROW = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";
const OTHER = "0x1111111111111111111111111111111111111111";
const USDC = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const CREATOR = "0xc0ffee0000000000000000000000000000000001";
const A = "0xa000000000000000000000000000000000000001";
const B = "0xb000000000000000000000000000000000000002";
const TX = () => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

const ctl = vi.hoisted(() => ({
  plans: new Map<string, { owner: string; state: string; actionId: string; txHash: string }>(),
  receipts: new Map<string, { status: string; logs: unknown[] }>(),
}));
vi.mock("@/lib/plan/service", () => ({
  getPlan: async (auth: { wallet: string }, planId: string) => {
    const p = ctl.plans.get(planId);
    if (!p || p.owner !== auth.wallet.toLowerCase()) throw Object.assign(new Error("nf"), { code: "NOT_FOUND" });
    return { planId, state: p.state, abandoned: false, expired: false, nodes: [{ ref: { protocolId: "payai-rooms", actionId: p.actionId, version: "1.0.0" }, txHash: p.txHash, signing: null, result: p.state === "completed" ? { status: "confirmed", outputs: {} } : null }] };
  },
}));
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = ctl.receipts.get(hash.toLowerCase());
      if (!r) throw new Error("not found");
      return r;
    },
  }),
}));
vi.mock("@/lib/rooms/escrowRead", () => {
  class EscrowUnavailableError extends Error {}
  return { EscrowUnavailableError, readChainRoom: async () => { throw new EscrowUnavailableError("chain reads are not part of this test"); }, readStatus: async () => "open" };
});

const KEYS = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_ROOM_ESCROW", "PAYAI_ROOM_ESCROW_ENABLED"] as const;
const SAVED: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) SAVED[k] = process.env[k];
  process.env.KV_REST_API_URL = URL_;
  process.env.KV_REST_API_TOKEN = TOKEN;
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_ROOM_ESCROW = ESCROW;
  process.env.PAYAI_ROOM_ESCROW_ENABLED = "true";
});
// Load the module graph once, up front: concurrent FIRST dynamic imports can
// race vitest's module mocking.
beforeAll(async () => { await import("@/lib/plan/service"); await import("@/lib/rooms/escrowService"); });
afterAll(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });
beforeEach(() => { ctl.plans.clear(); ctl.receipts.clear(); });

async function abi() { return (await import("@/lib/rooms/escrowChain")).ROOM_ESCROW_ABI; }
async function log(eventName: string, args: Record<string, unknown>, address = ESCROW) {
  const ROOM_ESCROW_ABI = await abi();
  const ev = ROOM_ESCROW_ABI.find((x) => x.type === "event" && x.name === eventName) as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi: ROOM_ESCROW_ABI, eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  return { address, topics, data: plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) : "0x" };
}

/** A live escrow room in the real store, adopted as on-chain room `chainId`. */
const RUN = BigInt(Math.floor(Math.random() * 1e9)) * 1000n; // unique on-chain ids per run (the store persists)
let fresh = 0;
/** `unique`: give this call its own on-chain id (n+1000k) while events still
 *  name room RUN+n — so a case whose events point at RUN+105 tests a MISMATCH. */
async function liveRoom(n: string, unique = false) {
  const chainId = (RUN + BigInt(n) + (unique ? BigInt(1000 * ++fresh) : 0n)).toString();
  const store = await import("@/lib/rooms/escrowStore");
  const id = `er_${TX().slice(2, 26)}`;
  await store.createEscrowRecord({
    id, mode: "escrow", kind: "target", creator: CREATOR, beneficiary: CREATOR, beneficiaryLabel: null,
    asset: { symbol: "USDC", address: USDC, decimals: 6, native: false }, title: "KV test", description: "", publicListing: true,
    shareUnits: "0", slots: 0, targetUnits: "100000000", minUnits: "0", deadline: 2_000_000_000, termsHash: `0x${"00".repeat(32)}`,
    escrow: ESCROW, feeBps: 50, createdAt: Date.now(),
  });
  expect(await store.adoptEscrowChain(id, { roomId: chainId, txHash: TX(), adoptedAt: Date.now() })).toBe(true);
  return id;
}
/** A completed contribute plan for `wallet` whose receipt carries `logs`. */
async function settled(id: string, wallet: string, logs: unknown[], opts: { state?: string; status?: string; kind?: "contribute" | "refund" } = {}) {
  const store = await import("@/lib/rooms/escrowStore");
  const planId = `plan_${TX().slice(2, 34)}`;
  const txHash = TX();
  ctl.plans.set(planId, { owner: wallet, state: opts.state ?? "completed", actionId: opts.kind ?? "contribute", txHash });
  ctl.receipts.set(txHash, { status: opts.status ?? "success", logs });
  await store.setEscrowPlan(id, wallet, opts.kind ?? "contribute", planId);
  return { planId, txHash };
}
async function confirm(id: string, wallet: string, kind: "contribute" | "refund" = "contribute") {
  const { confirmEscrowAction } = await import("@/lib/rooms/escrowService");
  try { await confirmEscrowAction(id, wallet, kind); return "OK"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
}
const contributions = async (id: string) => (await (await import("@/lib/rooms/escrowStore")).readEscrowLog(id)).filter((e) => e.kind === "contributed");

run("escrow rooms on a real KV", () => {
  it("contributions from different people are each counted once (service, sequential)", async () => {
    const id = await liveRoom("101");
    await settled(id, A, [await log("Contributed", { roomId: RUN + 101n, contributor: A, amount: 4n, raised: 4n })]);
    await settled(id, B, [await log("Contributed", { roomId: RUN + 101n, contributor: B, amount: 6n, raised: 10n })]);
    expect([await confirm(id, A), await confirm(id, B)]).toEqual(["OK", "OK"]);
    expect((await contributions(id)).map((x) => x.amountUnits).sort()).toEqual(["4", "6"]);
  });

  it("concurrent writes to the real store: distinct transactions all land, a repeated one lands once", async () => {
    // Store-level concurrency (the KV's SET NX is what makes this safe). Kept
    // below the service because vitest's module mocking is unreliable when
    // several wallets enter the mocked Plan Service at once.
    const store = await import("@/lib/rooms/escrowStore");
    const id = await liveRoom("109");
    const txs = Array.from({ length: 8 }, () => TX());
    const actors = txs.map((_, i) => `0x${(0xd000 + i).toString(16).padStart(40, "0")}`);
    const res = await Promise.all(txs.map((t, i) => store.logEscrowEvent(id, { kind: "contributed", txHash: t, actor: actors[i], amountUnits: "1", at: Date.now() })));
    expect(res.every(Boolean)).toBe(true);
    const dup = TX();
    const dupRes = await Promise.all(Array.from({ length: 6 }, () => store.logEscrowEvent(id, { kind: "contributed", txHash: dup, actor: A, amountUnits: "2", at: Date.now() })));
    expect(dupRes.every(Boolean)).toBe(true); // same owner → idempotent "already counted for you"
    const theft = await store.logEscrowEvent(id, { kind: "contributed", txHash: dup, actor: B, amountUnits: "2", at: Date.now() });
    expect(theft).toBe(false); // the same tx can't be claimed by someone else
    expect((await contributions(id)).length).toBe(9);
  });

  it("the same transaction confirmed many times at once is logged exactly once", async () => {
    const id = await liveRoom("102");
    await settled(id, A, [await log("Contributed", { roomId: RUN + 102n, contributor: A, amount: 5n, raised: 5n })]);
    await Promise.all(Array.from({ length: 6 }, () => confirm(id, A)));
    expect((await contributions(id)).length).toBe(1);
  });

  it("a transaction can't be counted for a second room", async () => {
    const id1 = await liveRoom("103");
    const id2 = await liveRoom("104");
    const ev = [await log("Contributed", { roomId: RUN + 103n, contributor: A, amount: 5n, raised: 5n })];
    const { txHash } = await settled(id1, A, ev);
    expect(await confirm(id1, A)).toBe("OK");
    // Point id2's plan at the SAME transaction.
    const store = await import("@/lib/rooms/escrowStore");
    const planId = `plan_${TX().slice(2, 34)}`;
    ctl.plans.set(planId, { owner: A, state: "completed", actionId: "contribute", txHash });
    await store.setEscrowPlan(id2, A, "contribute", planId);
    expect(await confirm(id2, A)).toBe("MISMATCH"); // the event names room 103, not 104
    expect(await contributions(id2)).toEqual([]);
  });

  it.each([
    ["another contributor's event", async (rid: bigint) => [await log("Contributed", { roomId: rid, contributor: B, amount: 5n, raised: 5n })], {}],
    ["another room's event", async (rid: bigint) => [await log("Contributed", { roomId: rid + 1n, contributor: A, amount: 5n, raised: 5n })], {}],
    ["an event from another contract", async (rid: bigint) => [await log("Contributed", { roomId: rid, contributor: A, amount: 5n, raised: 5n }, OTHER)], {}],
    ["a reverted transaction", async (rid: bigint) => [await log("Contributed", { roomId: rid, contributor: A, amount: 5n, raised: 5n })], { status: "reverted" }],
    ["a receipt with no event", async () => [], {}],
    ["a malformed log", async () => [{ address: ESCROW, topics: [], data: "0x12" }], {}],
    ["two contribution events in one receipt", async (rid: bigint) => { const l = await log("Contributed", { roomId: rid, contributor: A, amount: 5n, raised: 5n }); return [l, l]; }, {}],
  ])("refuses %s — nothing is counted", async (_n, logs, opts) => {
    const id = await liveRoom("105", true);
    const rid = BigInt((await (await import("@/lib/rooms/escrowStore")).getEscrowChain(id))!.roomId);
    await settled(id, A, await (logs as (r: bigint) => Promise<unknown[]>)(rid), opts as { status?: string });
    expect(await confirm(id, A)).toBe("MISMATCH");
    expect(await contributions(id)).toEqual([]);
  });

  it("a pending (not yet confirmed) transaction is never counted", async () => {
    const id = await liveRoom("106");
    await settled(id, A, [await log("Contributed", { roomId: RUN + 106n, contributor: A, amount: 5n, raised: 5n })], { state: "running" });
    expect(await confirm(id, A)).toBe("NOT_SETTLED");
    expect(await contributions(id)).toEqual([]);
  });

  it("a refund is recorded only from the escrow's Refunded event for this wallet", async () => {
    const id = await liveRoom("107");
    await settled(id, A, [await log("Refunded", { roomId: RUN + 107n, contributor: B, amount: 5n })], { kind: "refund" });
    expect(await confirm(id, A, "refund")).toBe("MISMATCH");
    await settled(id, A, [await log("Refunded", { roomId: RUN + 107n, contributor: A, amount: 5n })], { kind: "refund" });
    expect(await confirm(id, A, "refund")).toBe("OK");
    const logEntries = await (await import("@/lib/rooms/escrowStore")).readEscrowLog(id);
    expect(logEntries.filter((e) => e.kind === "refunded").map((e) => e.amountUnits)).toEqual(["5"]);
  });

  it("an on-chain room is adopted by at most one app room, even under a race", async () => {
    const store = await import("@/lib/rooms/escrowStore");
    const chainId = String(200 + Math.floor(Math.random() * 1e6));
    const ids = await Promise.all([0, 1, 2].map(async () => {
      const id = `er_${TX().slice(2, 26)}`;
      return { id, ok: await store.adoptEscrowChain(id, { roomId: chainId, txHash: TX(), adoptedAt: 1 }) };
    }));
    expect(ids.filter((x) => x.ok).length).toBe(1);
  });

  it("room records are write-once", async () => {
    const store = await import("@/lib/rooms/escrowStore");
    const id = await liveRoom("108");
    const rec = await store.getEscrowRecord(id);
    await expect(store.createEscrowRecord({ ...rec!, title: "changed" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await store.getEscrowRecord(id))?.title).toBe("KV test");
  });
});
