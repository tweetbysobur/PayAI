import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Abi } from "viem";

/**
 * PayAI Rooms on a REAL KV — not the in-memory store.
 *
 * Runs only when ROOMS_KV_TEST_URL / ROOMS_KV_TEST_TOKEN point at a
 * non-production, Upstash-REST-compatible store (locally: redis-server behind
 * an Upstash REST shim; in CI: an Upstash dev database). Skipped otherwise.
 * Every key it writes lives under payai:rooms: with random room ids.
 *
 * Real: the room store and service, @upstash/redis, the KV adapter, and the
 * forwarder's event DECODERS (receipts are built from real ABI-encoded logs).
 * Mocked: the Plan Service / intake (no plan executes) and the chain read
 * (getTransactionReceipt returns the crafted receipt). No funds, no network
 * beyond the local store.
 */

const URL_ = process.env.ROOMS_KV_TEST_URL;
const TOKEN = process.env.ROOMS_KV_TEST_TOKEN;
const run = URL_ && TOKEN ? describe : describe.skip;

const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const TREASURY = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const CREATOR = "0xc0ffee0000000000000000000000000000000001";
const P = (n: number) => `0x${(0xb000 + n).toString(16).padStart(40, "0")}`;
const TX = () => `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

const ctl = vi.hoisted(() => ({
  plans: new Map<string, { state: string; abandoned: boolean; expired: boolean; approved?: boolean; owner: string; nodes: { ref: { protocolId: string; actionId: string; version: string }; txHash: string | null; signing: null; result: null | { status: string; outputs: Record<string, unknown> } }[] }>(),
  intakeCalls: 0,
  receipts: new Map<string, { status: string; logs: unknown[] }>(),
}));

vi.mock("@/lib/plan/service", () => ({
  getPlan: async (auth: { wallet: string }, planId: string) => {
    const p = ctl.plans.get(planId);
    if (!p || p.owner !== auth.wallet.toLowerCase()) throw Object.assign(new Error("nf"), { code: "NOT_FOUND" });
    return { planId, ...structuredClone(p) };
  },
  getPlanWithReview: async (_a: unknown, planId: string) => ({ plan: { planId }, review: { steps: [{}] } }),
  abandonPlan: async (_a: unknown, planId: string) => { ctl.plans.get(planId)!.abandoned = true; },
}));
vi.mock("@/lib/plan-intake/intake", () => ({
  createPlanFromText: async (auth: { wallet: string }) => {
    ctl.intakeCalls++;
    const planId = `plan_${TX().slice(2, 34)}`;
    ctl.plans.set(planId, { state: "planned", abandoned: false, expired: false, owner: auth.wallet.toLowerCase(), nodes: [{ ref: { protocolId: "payai", actionId: "transfer", version: "1.0.0" }, txHash: null, signing: null, result: null }] });
    return { ok: true, plan: { planId }, review: { steps: [{}] } };
  },
}));
vi.mock("@/lib/payees/resolve", () => ({ resolveRecipientInput: async () => ({ ok: false, message: "n/a" }) }));
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = ctl.receipts.get(hash.toLowerCase());
      if (!r) throw new Error("receipt not found");
      return r;
    },
  }),
}));

const SAVED: Record<string, string | undefined> = {};
const KEYS = ["KV_REST_API_URL", "KV_REST_API_TOKEN", "MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED", "PAYAI_MODE"];
beforeAll(() => {
  for (const k of KEYS) SAVED[k] = process.env[k];
  process.env.KV_REST_API_URL = URL_;
  process.env.KV_REST_API_TOKEN = TOKEN;
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  process.env.PAYAI_FORWARDER_ENABLED = "true";
  process.env.PAYAI_MODE = "monad";
});
afterAll(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });
beforeEach(() => { ctl.plans.clear(); ctl.receipts.clear(); ctl.intakeCalls = 0; });

/** A separate "application instance": fresh modules, its own KV client. */
async function instance() {
  vi.resetModules();
  return import("@/lib/rooms/service");
}

/* ── Real forwarder logs ───────────────────────────────────────────────── */

async function forwarderLog(eventName: "PaymentForwarded" | "FeeCollected", args: Record<string, unknown>, address = FORWARDER) {
  const { PAYAI_FORWARDER_ABI, FORWARDER_FEE_COLLECTED_ABI } = await import("@/lib/monad/forwarder");
  const abi = (eventName === "PaymentForwarded" ? PAYAI_FORWARDER_ABI : FORWARDER_FEE_COLLECTED_ABI) as unknown as Abi;
  const ev = (abi as unknown as { type: string; name: string; inputs: { name: string; type: string; indexed?: boolean }[] }[]).find((e) => e.type === "event" && e.name === eventName)!;
  const topics = encodeEventTopics({ abi, eventName, args } as never);
  const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed), ev.inputs.filter((i) => !i.indexed).map((i) => args[i.name]) as never);
  return { address, topics, data };
}

/** A receipt for a forwarded USDC payment, exactly as the chain would report it. */
async function receipt(o: { payer: string; recipient: string; gross: bigint; fee: bigint; token?: string; id?: bigint; status?: string; extraForward?: boolean; noFee?: boolean }) {
  const id = o.id ?? 7n;
  const token = getAddress(o.token ?? USDC);
  const logs = [await forwarderLog("PaymentForwarded", { id, payer: getAddress(o.payer), recipient: getAddress(o.recipient), token, amount: o.gross, ref: `0x${"00".repeat(32)}` })];
  if (o.extraForward) logs.push(await forwarderLog("PaymentForwarded", { id: id + 1n, payer: getAddress(o.payer), recipient: getAddress(o.recipient), token, amount: o.gross, ref: `0x${"00".repeat(32)}` }));
  if (!o.noFee) logs.push(await forwarderLog("FeeCollected", { id, token, feeAmount: o.fee, treasury: TREASURY }));
  return { status: o.status ?? "success", logs };
}

/** Mark the participant's recorded plan completed with verified outputs + a receipt. */
async function settled(svcRoomId: string, who: string, tx: string, rec: Awaited<ReturnType<typeof receipt>>, share = "20000000") {
  const s = await instance();
  const v = await s.getRoom(svcRoomId, who);
  const p = ctl.plans.get(v.viewer.planId!)!;
  p.state = "completed";
  p.nodes[0].txHash = tx;
  p.nodes[0].result = { status: "confirmed", outputs: { amount: { verified: true, type: "units", value: share, token: USDC }, token: { verified: true, type: "token", value: USDC } } };
  ctl.receipts.set(tx.toLowerCase(), rec);
}

run("Rooms on a real KV", () => {
  it("state persists across separate application instances (fresh modules, fresh KV client)", async () => {
    const a = await instance();
    const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people", "Persisted");
    const b = await instance();
    expect((await b.getRoom(room.id, null)).memo).toBe("Persisted");
    await b.joinRoom(room.id, P(1));
    const c = await instance();
    const v = await c.getRoom(room.id, P(1));
    expect(v).toMatchObject({ joined: 1, viewer: { slot: 1 } });
    expect((await c.listMyRooms(CREATOR)).some((r) => r.id === room.id)).toBe(true);
  });

  it("40 concurrent joins from two instances never exceed a capacity of 5", async () => {
    const a = await instance();
    const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people", null);
    const b = await instance();
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).joinRoom(room.id, P(100 + i))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const v = await (await instance()).getRoom(room.id, null);
    expect(v.joined).toBe(5);
    expect(v.slots.map((s) => s.slot)).toEqual([1, 2, 3, 4, 5]);
  });

  it("the same wallet joining from two instances at once gets ONE place", async () => {
    const a = await instance();
    const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people", null);
    const b = await instance();
    const r = await Promise.allSettled([a.joinRoom(room.id, P(9)), b.joinRoom(room.id, P(9)), a.joinRoom(room.id, P(9))]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await (await instance()).getRoom(room.id, null)).joined).toBe(1);
  });

  it("starting a payment from two instances at once creates ONE plan", async () => {
    const a = await instance();
    const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people", null);
    await a.joinRoom(room.id, P(1));
    const b = await instance();
    await Promise.allSettled([a.startContribution(room.id, P(1)), b.startContribution(room.id, P(1)), b.startContribution(room.id, P(1))]);
    expect(ctl.intakeCalls).toBe(1);
  });

  describe("a share counts only when the REAL receipt matches payer, recipient, token and exact share", () => {
    async function paying() {
      const a = await instance();
      const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people", null);
      await a.joinRoom(room.id, P(1));
      await a.startContribution(room.id, P(1));
      return room.id;
    }

    it("20 USDC share, 0.05 USDC fee on top (gross 20.05) → counted", async () => {
      const id = await paying();
      const tx = TX();
      await settled(id, P(1), tx, await receipt({ payer: P(1), recipient: CREATOR, gross: 20_050_000n, fee: 50_000n }));
      const v = await (await instance()).confirmContribution(id, P(1));
      expect(v.paid).toBe(1);
      expect(v.slots[0]).toMatchObject({ state: "paid", txHash: tx });
    });

    const BAD: [string, Parameters<typeof receipt>[0]][] = [
      ["paid by another wallet", { payer: P(2), recipient: CREATOR, gross: 20_050_000n, fee: 50_000n }],
      ["paid to another recipient", { payer: P(1), recipient: P(3), gross: 20_050_000n, fee: 50_000n }],
      ["another token", { payer: P(1), recipient: CREATOR, gross: 20_050_000n, fee: 50_000n, token: "0x1111111111111111111111111111111111111111" }],
      ["net short of the share", { payer: P(1), recipient: CREATOR, gross: 20_000_000n, fee: 50_000n }],
      ["net over the share", { payer: P(1), recipient: CREATOR, gross: 20_100_000n, fee: 50_000n }],
      ["no FeeCollected event", { payer: P(1), recipient: CREATOR, gross: 20_000_000n, fee: 0n, noFee: true }],
      ["two forwarded payments in one transaction", { payer: P(1), recipient: CREATOR, gross: 20_050_000n, fee: 50_000n, extraForward: true }],
      ["a reverted transaction", { payer: P(1), recipient: CREATOR, gross: 20_050_000n, fee: 50_000n, status: "reverted" }],
    ];
    for (const [name, r] of BAD) {
      it(`${name} → MISMATCH, nothing counted`, async () => {
        const id = await paying();
        await settled(id, P(1), TX(), await receipt(r));
        await expect((await instance()).confirmContribution(id, P(1))).rejects.toMatchObject({ code: "MISMATCH" });
        expect((await (await instance()).getRoom(id, null)).paid).toBe(0);
      });
    }

    it("events from a contract other than the configured forwarder are ignored → MISMATCH", async () => {
      const id = await paying();
      const rec = await receipt({ payer: P(1), recipient: CREATOR, gross: 20_050_000n, fee: 50_000n });
      rec.logs = rec.logs.map((l) => ({ ...l, address: "0x9999999999999999999999999999999999999999" }));
      await settled(id, P(1), TX(), rec);
      await expect((await instance()).confirmContribution(id, P(1))).rejects.toMatchObject({ code: "MISMATCH" });
    });

    it("an unreadable receipt is UNAVAILABLE, never counted on a guess", async () => {
      const id = await paying();
      await settled(id, P(1), TX(), await receipt({ payer: P(1), recipient: CREATOR, gross: 20_050_000n, fee: 50_000n }));
      ctl.receipts.clear();
      await expect((await instance()).confirmContribution(id, P(1))).rejects.toMatchObject({ code: "UNAVAILABLE" });
    });

    it("one transaction can't count twice — not for a second room, not from two instances at once", async () => {
      const id1 = await paying();
      const tx = TX();
      const rec = await receipt({ payer: P(1), recipient: CREATOR, gross: 20_050_000n, fee: 50_000n });
      await settled(id1, P(1), tx, rec);
      const [x, y] = await Promise.allSettled([(await instance()).confirmContribution(id1, P(1)), (await instance()).confirmContribution(id1, P(1))]);
      expect([x.status, y.status]).toContain("fulfilled");
      expect((await (await instance()).getRoom(id1, null)).paid).toBe(1);

      const id2 = await paying();
      await settled(id2, P(1), tx, rec); // the SAME tx offered for another room
      await expect((await instance()).confirmContribution(id2, P(1))).rejects.toMatchObject({ code: "TX_ALREADY_COUNTED" });
      expect((await (await instance()).getRoom(id2, null)).paid).toBe(0);
    });
  });

  describe("failed, interrupted, expired and cancelled", () => {
    it("interrupted (sent, not settled): not counted, not replaced, and the room can't be cancelled under it", async () => {
      const a = await instance();
      const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people", null);
      await a.joinRoom(room.id, P(1));
      const { planId } = await a.startContribution(room.id, P(1));
      Object.assign(ctl.plans.get(planId)!, { state: "running", approved: true });
      ctl.plans.get(planId)!.nodes[0].txHash = TX();
      const b = await instance();
      await expect(b.confirmContribution(room.id, P(1))).rejects.toMatchObject({ code: "NOT_SETTLED" });
      expect((await b.startContribution(room.id, P(1))).planId).toBe(planId);
      await expect(b.cancelRoom(room.id, CREATOR)).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
    });

    it("failed (reverted, nothing sent): a new plan can be started", async () => {
      const a = await instance();
      const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people", null);
      await a.joinRoom(room.id, P(1));
      const first = await a.startContribution(room.id, P(1));
      Object.assign(ctl.plans.get(first.planId)!, { state: "failed" });
      ctl.plans.get(first.planId)!.nodes[0].result = { status: "reverted", outputs: {} };
      const second = await (await instance()).startContribution(room.id, P(1));
      expect(second.planId).not.toBe(first.planId);
    });

    it("expired: no joins, no new payments — persisted, derived on every instance", async () => {
      const a = await instance();
      const t0 = Date.now() - 2 * 86_400_000;
      const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people in 1 day", null, t0);
      const b = await instance();
      expect((await b.getRoom(room.id, null)).status).toBe("expired");
      await expect(b.joinRoom(room.id, P(1))).rejects.toMatchObject({ code: "CLOSED" });
    });

    it("cancelled: final across instances; the unapproved share plan is abandoned", async () => {
      const a = await instance();
      const room = await a.createRoom(CREATOR, "a room for 100 USDC for 5 people", null);
      await a.joinRoom(room.id, P(1));
      const { planId } = await a.startContribution(room.id, P(1));
      const b = await instance();
      expect((await b.cancelRoom(room.id, CREATOR)).status).toBe("cancelled");
      expect(ctl.plans.get(planId)!.abandoned).toBe(true);
      const c = await instance();
      await expect(c.cancelRoom(room.id, CREATOR)).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
      await expect(c.startContribution(room.id, P(1))).rejects.toMatchObject({ code: "CLOSED" });
    });
  });
});
