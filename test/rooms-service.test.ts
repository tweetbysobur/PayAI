import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PayAI Rooms — the service (lib/rooms/service.ts) over the REAL room store
 * (in-memory backend). Mocked: the Plan Service and plan intake (so a share's
 * plan can be put in any state), the recipient resolver, and — for the
 * Monad-mode receipt check — the chain read and the forwarder decoders.
 * Nothing here signs or sends anything.
 */

const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const FORWARDER = "0x8b2c7e8fa09fcd664dba9764fd63bf3a4c56464d";
const CREATOR = "0xc0ffee0000000000000000000000000000000001";
const BOB_NAD = "0xb0b0000000000000000000000000000000000002";
const P = (n: number) => `0x${(0xa000 + n).toString(16).padStart(40, "0")}`;
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const T0 = Date.UTC(2026, 9, 9, 12);

type PlanFake = {
  planId: string; state: string; abandoned: boolean; expired: boolean; approved?: boolean;
  nodes: { nodeId: string; ref: { protocolId: string; actionId: string; version: string }; txHash: string | null; signing: null | { quoteId: string };
    result: null | { status: string; outputs: Record<string, unknown> | null } }[];
};

const ctl = vi.hoisted(() => ({
  plans: new Map<string, PlanFake>(),
  owners: new Map<string, string>(),
  intakeTexts: [] as { wallet: string; text: string }[],
  intakeRefusal: null as null | { code: string; message: string },
  seq: 0,
  receipt: null as null | { status: string; logs: unknown[] },
  forwarded: null as null | { payer: string; recipient: string; token: string; amount: bigint; id: bigint },
  fee: 0n,
}));

vi.mock("@/lib/plan/service", () => ({
  getPlan: async (auth: { wallet: string }, planId: string) => {
    const p = ctl.plans.get(planId);
    if (!p || ctl.owners.get(planId) !== auth.wallet.toLowerCase()) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
    return structuredClone(p);
  },
  getPlanWithReview: async (auth: { wallet: string }, planId: string) => ({ plan: { planId, state: ctl.plans.get(planId)?.state }, review: { steps: [{}] } }),
  abandonPlan: async (auth: { wallet: string }, planId: string) => {
    if (ctl.owners.get(planId) !== auth.wallet.toLowerCase()) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
    ctl.plans.get(planId)!.abandoned = true;
  },
}));
vi.mock("@/lib/plan-intake/intake", () => ({
  createPlanFromText: async (auth: { wallet: string }, text: string) => {
    if (ctl.intakeRefusal) return { ok: false, ...ctl.intakeRefusal };
    ctl.intakeTexts.push({ wallet: auth.wallet.toLowerCase(), text });
    const planId = `plan_${(++ctl.seq).toString(16).padStart(32, "0")}`;
    ctl.plans.set(planId, { planId, state: "planned", abandoned: false, expired: false, nodes: [{ nodeId: "n1", ref: { protocolId: "payai", actionId: "transfer", version: "1.0.0" }, txHash: null, signing: null, result: null }] });
    ctl.owners.set(planId, auth.wallet.toLowerCase());
    return { ok: true, plan: { planId }, review: { steps: [{}] } };
  },
}));
vi.mock("@/lib/payees/resolve", () => ({
  resolveRecipientInput: async (input: string) => input === "bob.nad"
    ? { ok: true, address: BOB_NAD, source: "nad", display: "bob.nad", domain: "bob.nad", asResolved: "bob.nad" }
    : /^0x[0-9a-fA-F]{40}$/.test(input) ? { ok: true, address: input, source: "address", display: input, domain: null, asResolved: input }
    : { ok: false, message: `"${input}" isn't a valid address, .nad domain, or known payee.` },
}));
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({ getTransactionReceipt: async () => { if (!ctl.receipt) throw new Error("no receipt"); return ctl.receipt; } }),
}));
vi.mock("@/lib/monad/forwarder", () => ({
  decodePaymentForwarded: (logs: unknown[]) => (logs.length && ctl.forwarded ? ctl.forwarded : null),
  decodeFeeCollected: (logs: unknown[]) => (logs.length ? { feeAmount: ctl.fee, token: USDC } : null),
}));

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "PAYAI_MODE", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED"] as const;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  // Pin the clock to the fixture's day. Calls that don't pass a time use
  // Date.now(), and a room created at T0 expires a week later, so without
  // this the suite started failing on its own once the real date passed it.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + 60_000);
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  process.env.PAYAI_FORWARDER_ENABLED = "true";
  delete process.env.PAYAI_MODE;
  (await import("@/lib/rooms/store")).__resetRoomsForTests();
  ctl.plans.clear(); ctl.owners.clear(); ctl.intakeTexts.length = 0; ctl.intakeRefusal = null; ctl.seq = 0;
  ctl.receipt = null; ctl.forwarded = null; ctl.fee = 0n;
});
afterEach(() => { vi.useRealTimers(); for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const svc = () => import("@/lib/rooms/service");

/** Put the participant's recorded plan into a completed state with these verified outputs. */
function settle(planId: string, o: { amount?: string; token?: string; verified?: boolean; tx?: string; status?: string; state?: string; ref?: string } = {}) {
  const p = ctl.plans.get(planId)!;
  p.state = o.state ?? "completed";
  const n = p.nodes[0];
  n.txHash = o.tx ?? TX(ctl.seq);
  if (o.ref) n.ref = { protocolId: "payai", actionId: o.ref, version: "1.0.0" };
  n.result = {
    status: o.status ?? "confirmed",
    outputs: {
      amount: { verified: o.verified ?? true, type: "units", value: o.amount ?? "20000000", token: o.token ?? USDC },
      token: { verified: true, type: "token", value: o.token ?? USDC },
    },
  };
}

async function roomWith(n: number, text = "a room for 100 USDC for 5 people") {
  const s = await svc();
  const room = await s.createRoom(CREATOR, text, "Team dinner", T0);
  for (let i = 1; i <= n; i++) await s.joinRoom(room.id, P(i), T0 + i);
  return room.id;
}

describe("create", () => {
  it("a room is terms only — no plan, no transaction; the creator receives by default", async () => {
    const s = await svc();
    const v = await s.createRoom(CREATOR, "a room for 100 USDC for 5 people", "Team dinner", T0);
    expect(v).toMatchObject({ status: "open", total: "100", share: "20", target: 5, joined: 0, paid: 0, memo: "Team dinner", verified: false });
    expect(v.recipient.address.toLowerCase()).toBe(CREATOR);
    expect(v.viewer).toMatchObject({ isCreator: true, isRecipient: true, canJoin: false, canCancel: true });
    expect(v.id).toMatch(/^room_[0-9a-f]{24}$/);
    expect(ctl.intakeTexts).toHaveLength(0);
  });

  it("a named recipient is resolved once and snapshotted", async () => {
    const v = await (await svc()).createRoom(CREATOR, "100 USDC for 5 people to bob.nad", null, T0);
    expect(v.recipient.address.toLowerCase()).toBe(BOB_NAD);
    expect(v.recipient.label).toBe("bob.nad");
  });

  it("invalid parameters create nothing", async () => {
    const s = await svc();
    for (const [text, msg] of [
      ["100 USDC for 3 people", /doesn't split exactly/],
      ["100 DAI for 5 people", /not DAI/],
      ["100 A-USDC for 5 people", /Verified A-USDC rooms need Cleanverse/],
      ["100 USDC for 5 people to nobody", /isn't a valid address/],
      ["100 USDC for 99 people", /2 to 20/],
    ] as const) {
      await expect(s.createRoom(CREATOR, text, null, T0), text).rejects.toThrow(msg);
    }
    expect(await s.listMyRooms(CREATOR)).toHaveLength(0);
  });
});

describe("join", () => {
  it("joins take numbered places; the same wallet can't join twice", async () => {
    const id = await roomWith(2);
    const s = await svc();
    await expect(s.joinRoom(id, P(1), T0 + 9)).rejects.toMatchObject({ code: "ALREADY_JOINED" });
    const v = await s.getRoom(id, P(2), T0 + 10);
    expect(v.slots.map((x) => [x.slot, x.you])).toEqual([[1, false], [2, true]]);
  });

  it("capacity holds under concurrent joins — never more than the target", async () => {
    const s = await svc();
    const room = await s.createRoom(CREATOR, "a room for 9 USDC for 3 people", null, T0);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => s.joinRoom(room.id, P(i + 1), T0 + 1)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected").every((r) => ["FULL", "CLOSED"].includes((r as PromiseRejectedResult).reason.code))).toBe(true);
    expect((await s.getRoom(room.id, null, T0 + 2)).joined).toBe(3);
  });

  it("the recipient can't join (a share paid to oneself); a closed room takes nobody", async () => {
    const s = await svc();
    const id = await roomWith(0);
    await expect(s.joinRoom(id, CREATOR, T0 + 1)).rejects.toMatchObject({ code: "RECIPIENT_CANNOT_JOIN" });
    await s.cancelRoom(id, CREATOR, T0 + 2);
    await expect(s.joinRoom(id, P(1), T0 + 3)).rejects.toMatchObject({ code: "CLOSED" });
    const late = await roomWith(0);
    await expect(s.joinRoom(late, P(1), T0 + 8 * 86_400_000)).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("an unknown room is NOT_FOUND", async () => {
    await expect((await svc()).joinRoom("room_000000000000000000000000", P(1))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await svc()).getRoom("../etc", null)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("pay a share — an ordinary plan, written from the room's terms", () => {
  it("creates ONE plan per participant, as them, for exactly the share to the recipient — and reuses it", async () => {
    const id = await roomWith(1);
    const s = await svc();
    const a = await s.startContribution(id, P(1), T0 + 5);
    expect(ctl.intakeTexts).toHaveLength(1);
    expect(ctl.intakeTexts[0].wallet).toBe(P(1));
    expect(ctl.intakeTexts[0].text.toLowerCase()).toBe(`send 20 usdc to ${CREATOR}`);
    const b = await s.startContribution(id, P(1), T0 + 6);
    expect(b.planId).toBe(a.planId);
    expect(ctl.intakeTexts).toHaveLength(1);
    expect((await s.getRoom(id, P(1), T0 + 7)).slots[0].state).toBe("paying");
  });

  it("concurrent starts never create two plans", async () => {
    const id = await roomWith(1);
    const s = await svc();
    const r = await Promise.allSettled([s.startContribution(id, P(1)), s.startContribution(id, P(1)), s.startContribution(id, P(1))]);
    expect(ctl.intakeTexts).toHaveLength(1);
    for (const x of r) if (x.status === "rejected") expect(x.reason.code).toBe("BUSY");
  });

  it("an abandoned or expired unpaid plan is replaced; one with a transaction in flight is not", async () => {
    const id = await roomWith(1);
    const s = await svc();
    const first = await s.startContribution(id, P(1));
    ctl.plans.get(first.planId)!.abandoned = true;
    const second = await s.startContribution(id, P(1));
    expect(second.planId).not.toBe(first.planId);
    const p = ctl.plans.get(second.planId)!;
    p.state = "failed"; p.nodes[0].txHash = TX(9); // sent, not settled
    expect((await s.startContribution(id, P(1))).planId).toBe(second.planId);
    expect(ctl.intakeTexts).toHaveLength(2);
  });

  it("refused: not joined, already paid, closed room, payments unavailable", async () => {
    const id = await roomWith(1);
    const s = await svc();
    await expect(s.startContribution(id, P(7))).rejects.toMatchObject({ code: "NOT_JOINED" });
    ctl.intakeRefusal = { code: "ACTION_UNAVAILABLE", message: "x" };
    await expect(s.startContribution(id, P(1))).rejects.toMatchObject({ code: "PAYMENT_UNAVAILABLE", message: expect.stringMatching(/isn't available/) });
    ctl.intakeRefusal = null;
    const { planId } = await s.startContribution(id, P(1));
    settle(planId);
    await s.confirmContribution(id, P(1), T0 + 10);
    await expect(s.startContribution(id, P(1))).rejects.toMatchObject({ code: "ALREADY_PAID" });
    const closed = await roomWith(1);
    await expect(s.startContribution(closed, P(1), T0 + 30 * 86_400_000)).rejects.toMatchObject({ code: "CLOSED" });
  });
});

describe("confirm — counted only from the plan's verified on-chain result", () => {
  async function paying(n = 1) {
    const id = await roomWith(n);
    const { planId } = await (await svc()).startContribution(id, P(1), T0 + 5);
    return { id, planId };
  }

  it("not settled yet → NOT_SETTLED, nothing counted", async () => {
    const { id } = await paying();
    await expect((await svc()).confirmContribution(id, P(1))).rejects.toMatchObject({ code: "NOT_SETTLED" });
  });

  it("verified share and token → counted; idempotent; the hash shows only to its payer", async () => {
    const { id, planId } = await paying(2);
    settle(planId, { tx: TX(77) });
    const s = await svc();
    const v = await s.confirmContribution(id, P(1), T0 + 10);
    expect(v.paid).toBe(1);
    expect(v.slots[0]).toMatchObject({ state: "paid", paidAt: T0 + 10, txHash: TX(77), you: true });
    expect((await s.confirmContribution(id, P(1), T0 + 11)).paid).toBe(1);
    const other = await s.getRoom(id, P(2), T0 + 12);
    expect(other.slots[0].txHash).toBeNull();
    expect(JSON.stringify(other)).not.toContain(P(1).slice(2));
  });

  const BAD: [string, Parameters<typeof settle>[1], string][] = [
    ["a different amount", { amount: "19999999" }, "MISMATCH"],
    ["a different token", { token: "0x1111111111111111111111111111111111111111" }, "MISMATCH"],
    ["an unverified output", { verified: false }, "MISMATCH"],
    ["a reverted result", { status: "reverted" }, "MISMATCH"],
    ["another action", { ref: "swap" }, "MISMATCH"],
    ["a failed plan", { state: "failed" }, "NOT_SETTLED"],
  ];
  for (const [name, o, code] of BAD) {
    it(`${name} → ${code}, nothing counted`, async () => {
      const { id, planId } = await paying();
      settle(planId, o);
      const s = await svc();
      await expect(s.confirmContribution(id, P(1))).rejects.toMatchObject({ code });
      expect((await s.getRoom(id, null)).paid).toBe(0);
    });
  }

  it("a transaction already counted elsewhere can't count twice", async () => {
    const s = await svc();
    const a = await paying();
    settle(a.planId, { tx: TX(5) });
    await s.confirmContribution(a.id, P(1));
    const b = await roomWith(1);
    const { planId } = await s.startContribution(b, P(1));
    settle(planId, { tx: TX(5) });
    await expect(s.confirmContribution(b, P(1))).rejects.toMatchObject({ code: "TX_ALREADY_COUNTED" });
  });

  it("someone else's plan is never readable as yours", async () => {
    const { id, planId } = await paying();
    settle(planId);
    ctl.owners.set(planId, P(9)); // the plan belongs to another wallet
    await expect((await svc()).confirmContribution(id, P(1))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the room completes on the target-th share", async () => {
    const s = await svc();
    const room = await s.createRoom(CREATOR, "a room for 10 USDC for 2 people", null, T0);
    for (const i of [1, 2]) {
      await s.joinRoom(room.id, P(i), T0 + i);
      const { planId } = await s.startContribution(room.id, P(i), T0 + 3);
      settle(planId, { amount: "5000000", tx: TX(100 + i) });
      await s.confirmContribution(room.id, P(i), T0 + 10 + i);
    }
    const v = await s.getRoom(room.id, CREATOR, T0 + 20);
    expect(v).toMatchObject({ status: "completed", paid: 2, completedAt: T0 + 12 });
    expect(v.activity.map((a) => a.kind)).toEqual(["created", "joined", "joined", "paid", "paid", "completed"]);
  });

  it("a share that lands after the room expired is recorded — as late — and doesn't complete it", async () => {
    const s = await svc();
    const room = await s.createRoom(CREATOR, "a room for 10 USDC for 2 people in 1 day", null, T0);
    await s.joinRoom(room.id, P(1), T0 + 1);
    const { planId } = await s.startContribution(room.id, P(1), T0 + 2);
    settle(planId, { amount: "5000000" });
    const v = await s.confirmContribution(room.id, P(1), T0 + 2 * 86_400_000);
    expect(v.status).toBe("expired");
    expect(v.slots[0]).toMatchObject({ state: "paid", afterClose: true });
  });
});

describe("Monad mode re-checks the receipt itself", () => {
  beforeEach(() => { process.env.PAYAI_MODE = "monad"; });

  async function ready() {
    const id = await roomWith(1);
    const { planId } = await (await svc()).startContribution(id, P(1));
    settle(planId);
    ctl.receipt = { status: "success", logs: [{}] };
    return id;
  }

  it("payer, recipient, token and net all match → counted", async () => {
    const id = await ready();
    ctl.forwarded = { payer: P(1), recipient: CREATOR, token: USDC, amount: 20_050_000n, id: 1n };
    ctl.fee = 50_000n;
    expect((await (await svc()).confirmContribution(id, P(1))).paid).toBe(1);
  });

  for (const [name, patch] of [
    ["paid by someone else", { payer: P(9) }],
    ["paid to someone else", { recipient: P(9) }],
    ["a different token", { token: "0x1111111111111111111111111111111111111111" }],
    ["a net that isn't the share", { amount: 20_000_000n }],
  ] as const) {
    it(`${name} → MISMATCH`, async () => {
      const id = await ready();
      ctl.forwarded = Object.assign({ payer: P(1), recipient: CREATOR, token: USDC, amount: 20_050_000n, id: 1n }, patch);
      ctl.fee = 50_000n;
      await expect((await svc()).confirmContribution(id, P(1))).rejects.toMatchObject({ code: "MISMATCH" });
    });
  }

  it("an unreadable receipt is UNAVAILABLE — never counted on a guess", async () => {
    const id = await ready();
    ctl.receipt = null;
    await expect((await svc()).confirmContribution(id, P(1))).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("cancel", () => {
  it("only the creator", async () => {
    const id = await roomWith(1);
    await expect((await svc()).cancelRoom(id, P(1))).rejects.toMatchObject({ code: "NOT_CREATOR" });
  });

  it("not once someone has paid", async () => {
    const id = await roomWith(1);
    const s = await svc();
    const { planId } = await s.startContribution(id, P(1));
    settle(planId);
    await s.confirmContribution(id, P(1));
    await expect(s.cancelRoom(id, CREATOR)).rejects.toMatchObject({ code: "NOT_CANCELLABLE", message: expect.stringMatching(/can't be undone/) });
  });

  it("not while a share is approved or has a transaction under way", async () => {
    const id = await roomWith(1);
    const s = await svc();
    const { planId } = await s.startContribution(id, P(1));
    const p = ctl.plans.get(planId)!;
    Object.assign(p, { state: "running", approved: true });
    await expect(s.cancelRoom(id, CREATOR)).rejects.toMatchObject({ code: "NOT_CANCELLABLE", message: expect.stringMatching(/under way/) });
    Object.assign(p, { state: "failed", approved: true });
    p.nodes[0].txHash = TX(3); // sent, not settled
    await expect(s.cancelRoom(id, CREATOR)).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
    p.nodes[0].txHash = null;
    p.nodes[0].signing = { quoteId: "q1" }; // a signature may be pending
    await expect(s.cancelRoom(id, CREATOR)).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
  });

  it("an unapproved share plan doesn't block cancelling — it is abandoned, so it can never pay into the cancelled room", async () => {
    const id = await roomWith(1);
    const s = await svc();
    const { planId } = await s.startContribution(id, P(1));
    expect(ctl.plans.get(planId)!.abandoned).toBe(false);
    const v = await s.cancelRoom(id, CREATOR, T0 + 100);
    expect(v.status).toBe("cancelled");
    expect(v.slots[0].state).toBe("joined"); // no longer "paying" — the room can't take it
    expect(ctl.plans.get(planId)!.abandoned).toBe(true);
    await expect(s.startContribution(id, P(1))).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("is final", async () => {
    const id = await roomWith(0);
    const s = await svc();
    await s.cancelRoom(id, CREATOR, T0 + 1);
    await expect(s.cancelRoom(id, CREATOR, T0 + 2)).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
  });
});

describe("listing and privacy", () => {
  it("lists the rooms a wallet created or joined, newest first; never another wallet's", async () => {
    const s = await svc();
    const a = await s.createRoom(CREATOR, "a room for 10 USDC for 2 people", "A", T0);
    const b = await s.createRoom(CREATOR, "a room for 20 USDC for 2 people", "B", T0 + 1);
    await s.joinRoom(a.id, P(1), T0 + 2);
    expect((await s.listMyRooms(CREATOR)).map((r) => r.memo)).toEqual(["B", "A"]);
    expect((await s.listMyRooms(P(1))).map((r) => [r.memo, r.role])).toEqual([["A", "participant"]]);
    expect(await s.listMyRooms(P(2))).toEqual([]);
    expect(b).toBeTruthy();
  });

  it("an anonymous view carries no participant address at all", async () => {
    const id = await roomWith(3);
    const json = JSON.stringify(await (await svc()).getRoom(id, null));
    for (const i of [1, 2, 3]) expect(json.toLowerCase()).not.toContain(P(i).slice(2));
  });
});

describe("restart safety", () => {
  it("state survives a fresh module load (it's all in the store, nothing in memory of the service)", async () => {
    const id = await roomWith(1);
    await (await svc()).startContribution(id, P(1));
    vi.resetModules();
    const again = await import("@/lib/rooms/service");
    expect((await again.getRoom(id, P(1))).viewer.planId).toMatch(/^plan_/);
  });
});
