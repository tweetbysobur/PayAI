/**
 * Escrow Rooms — the app side of PayAIRoomEscrow, without a chain.
 *
 * What these prove: the event decoders accept ONLY the configured escrow's
 * own, single, successful event; the SDK actions enforce the contract's rules
 * before anything is built (token, status, amount, eligibility) and build only
 * typed calls to the escrow (exact approve for USDC); and a confirmed result
 * is accepted only when the escrow's event matches the build's terms AND
 * wallet. The chain reads here are an INJECTED fake reader — this is not
 * proof of on-chain behaviour (that's contracts/test/PayAIRoomEscrow.test.js
 * on Hardhat's EVM, and the local-chain browser run).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from "viem";
import {
  ROOM_ESCROW_ABI, ERC20_APPROVE_ABI, NATIVE, ROOM_MIN_CONTRIBUTION_MON, ROOM_MIN_CONTRIBUTION_USDC, roomMinimumUnits, contributionProblem, decodeContributed, decodeRoomCreated, decodeClaimed, decodeRefunded,
  deriveEscrowStatus, escrowClaimFee, feePercent, roomTermsHash, ROOM_FEE_BPS, type ChainRoom,
} from "@/lib/rooms/escrowChain";
import { createRoomEscrowProtocol, verifyContribution, type EscrowReader } from "@/lib/sdk/actions/room-escrow";
import type { Action, ActionReceipt } from "@/lib/sdk/types";

const ESCROW = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const OTHER = getAddress("0x1111111111111111111111111111111111111111");
const USDC = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const CREATOR = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const ALICE = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const BOB = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const TREASURY = getAddress("0xd46fe549ce3f36f22587f0bfe4b4ac435184f69c");
const NOW = 1_800_000_000n;

const env = { ...process.env };
beforeAll(() => { process.env.MONAD_NETWORK = "mainnet"; process.env.MONAD_MAINNET_USDC = USDC; });
afterAll(() => { process.env = env; });

function log(eventName: string, args: Record<string, unknown>, address: Address = ESCROW) {
  const ev = ROOM_ESCROW_ABI.find((x) => x.type === "event" && x.name === eventName) as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi: ROOM_ESCROW_ABI, eventName, args } as never) as Hex[];
  const plain = ev.inputs.filter((i) => !i.indexed);
  const data = plain.length ? encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never) : "0x";
  return { address, topics, data: data as Hex };
}
const receipt = (logs: ReturnType<typeof log>[], status: "success" | "reverted" = "success"): ActionReceipt =>
  ({ status, txHash: `0x${"ab".repeat(32)}`, logs } as ActionReceipt);

function room(over: Partial<ChainRoom> = {}): ChainRoom {
  return {
    creator: CREATOR, beneficiary: CREATOR, token: USDC, treasury: TREASURY, kind: 1, feeBps: 50, deadline: NOW + 86_400n, slots: 0,
    share: 0n, target: 100_000_000n, minContribution: 1_000_000n, termsHash: `0x${"00".repeat(32)}`, raised: 0n, refunded: 0n,
    contributors: 0, completedAt: 0n, claimed: false, cancelled: false, ...over,
  };
}

function reader(r: ChainRoom, opts: { contributed?: bigint; paused?: boolean; supported?: boolean; now?: bigint; feeBps?: number; floor?: bigint; decimals?: number } = {}): () => Promise<EscrowReader> {
  return async () => ({
    room: async () => r,
    contributionOf: async () => opts.contributed ?? 0n,
    tokenSupported: async () => opts.supported ?? true,
    feeTerms: async () => ({ feeBps: opts.feeBps ?? 50, treasury: TREASURY }),
    paused: async () => opts.paused ?? false,
    nowSec: async () => opts.now ?? NOW,
    minContributionFloor: async (t: Address) => opts.floor ?? (t === NATIVE ? 10n ** 18n : 500_000n),
    tokenDecimals: async () => opts.decimals ?? 6,
  });
}

function actions(r: ChainRoom, opts?: Parameters<typeof reader>[1]): Record<string, Action> {
  const p = createRoomEscrowProtocol(ESCROW, reader(r, opts), 143)!;
  return Object.fromEntries(p.actions.map((a) => [a.actionId, a]));
}

/* ── Decoders ─────────────────────────────────────────────────────────── */

describe("escrow event decoders", () => {
  const contributed = () => log("Contributed", { roomId: 3n, contributor: ALICE, amount: 5n, raised: 9n });
  it("decode exactly one event from the configured escrow", () => {
    expect(decodeContributed(receipt([contributed()]), ESCROW)).toEqual({ roomId: 3n, contributor: ALICE, amount: 5n, raised: 9n });
  });
  it("ignore the same event from any other address", () => {
    expect(decodeContributed(receipt([contributed(), log("Contributed", { roomId: 3n, contributor: ALICE, amount: 5n, raised: 9n }, OTHER)].slice(1)), ESCROW)).toBeNull();
  });
  it("refuse duplicates, reverted receipts, missing events and malformed logs", () => {
    expect(decodeContributed(receipt([contributed(), contributed()]), ESCROW)).toBeNull();
    expect(decodeContributed(receipt([contributed()], "reverted"), ESCROW)).toBeNull();
    expect(decodeContributed(receipt([]), ESCROW)).toBeNull();
    expect(decodeContributed(receipt([{ ...contributed(), data: "0x1234" }]), ESCROW)).toBeNull();
    expect(decodeContributed(receipt([{ ...contributed(), topics: [] }]), ESCROW)).toBeNull();
    expect(decodeContributed(null, ESCROW)).toBeNull();
    expect(decodeContributed({ status: "success", logs: "nope" } as never, ESCROW)).toBeNull();
  });
  it("don't confuse one event for another", () => {
    const refunded = log("Refunded", { roomId: 3n, contributor: ALICE, amount: 5n });
    expect(decodeContributed(receipt([refunded]), ESCROW)).toBeNull();
    expect(decodeRefunded(receipt([refunded]), ESCROW)).toEqual({ roomId: 3n, contributor: ALICE, amount: 5n });
    expect(decodeClaimed(receipt([refunded]), ESCROW)).toBeNull();
  });
  it("decode RoomCreated with every term", () => {
    const ev = log("RoomCreated", {
      roomId: 0n, creator: CREATOR, beneficiary: ALICE, token: NATIVE, kind: 0, share: 10n, slots: 3, target: 30n, minContribution: 0n,
      deadline: NOW, feeBps: 50, treasury: TREASURY, termsHash: `0x${"11".repeat(32)}`,
    });
    expect(decodeRoomCreated(receipt([ev]), ESCROW)).toMatchObject({ roomId: 0n, creator: CREATOR, beneficiary: ALICE, kind: 0, slots: 3, target: 30n, feeBps: 50 });
  });
});

/* ── Pure rules ───────────────────────────────────────────────────────── */

describe("pure rules mirror the contract", () => {
  it("status boundary: open strictly before the deadline, expired at it", () => {
    const r = room({ deadline: NOW });
    expect(deriveEscrowStatus(r, NOW - 1n)).toBe("open");
    expect(deriveEscrowStatus(r, NOW)).toBe("expired");
    expect(deriveEscrowStatus(room({ completedAt: 5n }), NOW + 10n ** 9n)).toBe("completed");
    expect(deriveEscrowStatus(room({ completedAt: 5n, claimed: true }), NOW)).toBe("claimed");
    expect(deriveEscrowStatus(room({ cancelled: true }), NOW)).toBe("cancelled");
    expect(deriveEscrowStatus(room({ creator: NATIVE }), NOW)).toBe("none");
  });
  it("contribution amounts: fixed takes exactly one share once; target caps at the remainder with a final-remainder exception", () => {
    const fixed = room({ kind: 0, share: 10n, slots: 3, target: 30n, minContribution: 0n });
    expect(contributionProblem(fixed, 10n, 0n)).toBeNull();
    expect(contributionProblem(fixed, 9n, 0n)).toMatch(/exactly one share/);
    expect(contributionProblem(fixed, 10n, 10n)).toMatch(/already paid/);
    const target = room({ target: 100n, raised: 99n, minContribution: 5n });
    expect(contributionProblem(target, 1n, 0n)).toBeNull(); // exactly the remainder
    expect(contributionProblem(target, 2n, 0n)).toMatch(/more than the room still needs/);
    expect(contributionProblem(room({ target: 100n, minContribution: 5n }), 4n, 0n)).toMatch(/below/);
    expect(contributionProblem(target, 0n, 0n)).toMatch(/more than zero/);
  });
  it("claim fee: 0.5%, floored exactly like the contract, capped at 0.5%", () => {
    expect(ROOM_FEE_BPS).toBe(50);
    expect(escrowClaimFee(1_000_000_000n, ROOM_FEE_BPS)).toEqual({ fee: 5_000_000n, net: 995_000_000n }); // 1,000 USDC → 5 / 995
    expect(escrowClaimFee(10_000_000n, ROOM_FEE_BPS)).toEqual({ fee: 50_000n, net: 9_950_000n });        // 10 USDC → 0.05 / 9.95
    expect(escrowClaimFee(10n ** 19n, ROOM_FEE_BPS)).toEqual({ fee: 5n * 10n ** 16n, net: 995n * 10n ** 16n }); // 10 MON
    expect(escrowClaimFee(399n, ROOM_FEE_BPS)).toEqual({ fee: 1n, net: 398n });
    expect(escrowClaimFee(199n, ROOM_FEE_BPS)).toEqual({ fee: 0n, net: 199n });
    expect(escrowClaimFee(0n, ROOM_FEE_BPS)).toEqual({ fee: 0n, net: 0n });
    expect(() => escrowClaimFee(1n, 51)).toThrow();
    expect(() => escrowClaimFee(1n, 100)).toThrow();
    expect(feePercent(50)).toBe("0.5%");
    expect(feePercent(25)).toBe("0.25%");
  });
  it("terms hash is deterministic and covers every field", () => {
    const a = roomTermsHash({ title: "Garden", description: "Seeds", publicListing: false });
    expect(roomTermsHash({ title: "Garden", description: "Seeds", publicListing: false })).toBe(a);
    expect(roomTermsHash({ title: "Garden", description: "Seeds", publicListing: true })).not.toBe(a);
    expect(roomTermsHash({ title: "Garden!", description: "Seeds", publicListing: false })).not.toBe(a);
  });
});

/* ── SDK actions ──────────────────────────────────────────────────────── */

describe("payai-rooms actions", () => {
  it("register nothing without a configured escrow", () => {
    delete process.env.PAYAI_ROOM_ESCROW_ENABLED;
    expect(createRoomEscrowProtocol()).toBeNull();
  });

  it("contribute (USDC): exact approve to the escrow, then the typed contribute call — nothing else", async () => {
    const a = actions(room()).contribute;
    const inputs = { roomId: "7", amount: "5000000", token: USDC };
    const q = await a.quote(inputs);
    expect(q.details.fee).toMatch(/You pay exactly this amount/);
    const steps = await a.build(inputs, q, { wallet: ALICE });
    expect(steps).toHaveLength(2);
    expect(steps[0].kind).toBe("approve");
    expect(steps[0].approval).toEqual({ token: USDC, spender: ESCROW, amount: "5000000" });
    expect(decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: steps[0].tx.data }).args).toEqual([ESCROW, 5_000_000n]);
    expect(steps[1].tx.to).toBe(ESCROW);
    expect(steps[1].tx.value).toBe("0");
    expect(decodeFunctionData({ abi: ROOM_ESCROW_ABI, data: steps[1].tx.data })).toMatchObject({ functionName: "contribute", args: [7n, 5_000_000n] });
  });

  it("contribute (MON): one step, value equals the amount", async () => {
    const a = actions(room({ token: NATIVE })).contribute;
    const q = await a.quote({ roomId: "1", amount: "1000000" });
    const steps = await a.build({ roomId: "1", amount: "1000000" }, q, { wallet: ALICE });
    expect(steps).toHaveLength(1);
    expect(steps[0].tx).toMatchObject({ to: ESCROW, value: "1000000" });
  });

  it("contribute refuses wrong token, closed rooms, paused contract, bad amounts and repeat fixed shares", async () => {
    await expect(actions(room()).contribute.quote({ roomId: "1", amount: "5000000" })).rejects.toThrow(/different token/);
    await expect(actions(room({ deadline: NOW })).contribute.quote({ roomId: "1", amount: "5000000", token: USDC })).rejects.toThrow(/expired/);
    await expect(actions(room({ cancelled: true })).contribute.quote({ roomId: "1", amount: "5000000", token: USDC })).rejects.toThrow(/cancelled/);
    await expect(actions(room(), { paused: true }).contribute.quote({ roomId: "1", amount: "5000000", token: USDC })).rejects.toThrow(/paused/);
    await expect(actions(room()).contribute.quote({ roomId: "1", amount: "500", token: USDC })).rejects.toThrow(/below/);
    await expect(actions(room()).contribute.quote({ roomId: "x", amount: "5000000", token: USDC })).rejects.toThrow(/room id/);
    await expect(actions(room()).contribute.quote({ roomId: "1", amount: "5000000", token: OTHER })).rejects.toThrow(/MON or PayAI's configured USDC/);
    await expect(actions(room({ creator: NATIVE })).contribute.quote({ roomId: "1", amount: "1", token: USDC })).rejects.toThrow(/doesn't exist/);
    const fixed = room({ kind: 0, share: 10n, slots: 3, target: 30n, minContribution: 0n });
    const a = actions(fixed, { contributed: 10n }).contribute;
    const q = await a.quote({ roomId: "1", amount: "10", token: USDC });
    await expect(a.build({ roomId: "1", amount: "10", token: USDC }, q, { wallet: ALICE })).rejects.toThrow(/already paid/);
  });

  it("a build whose room changed since the preview is refused", async () => {
    const a1 = actions(room()).contribute;
    const q = await a1.quote({ roomId: "1", amount: "5000000", token: USDC });
    const a2 = actions(room({ feeBps: 10 })).contribute;
    await expect(a2.build({ roomId: "1", amount: "5000000", token: USDC }, q, { wallet: ALICE })).rejects.toThrow(/changed since the preview/);
  });

  it("claim: only once complete; anyone may trigger it (PA-11) and it always pays the beneficiary; quotes the exact net and fee", async () => {
    await expect(actions(room({ raised: 50n })).claim.quote({ roomId: "1", token: USDC })).rejects.toThrow(/only once the room is complete/);
    await expect(actions(room({ completedAt: 1n, claimed: true })).claim.quote({ roomId: "1", token: USDC })).rejects.toThrow(/already been claimed/);
    const done = room({ raised: 100_000_000n, completedAt: 1n });
    const a = actions(done).claim;
    const q = await a.quote({ roomId: "1", token: USDC });
    expect(q.terms).toMatchObject({ net: "99500000", fee: "500000" });
    expect(q.summary).toMatch(/to its beneficiary/);
    expect(JSON.stringify(q)).toMatch(/Nothing — you only pay network gas/);
    // A stranger (BOB) can build the release; the calldata is the plain claim(roomId),
    // which the contract always pays to the room's fixed beneficiary.
    for (const wallet of [BOB, CREATOR]) {
      const steps = await a.build({ roomId: "1", token: USDC }, q, { wallet });
      expect(steps).toHaveLength(1);
      expect(steps[0].tx.to.toLowerCase()).toBe(ESCROW.toLowerCase());
      expect(String(steps[0].tx.value ?? "0")).toBe("0");
      expect(decodeFunctionData({ abi: ROOM_ESCROW_ABI, data: steps[0].tx.data })).toMatchObject({ functionName: "claim", args: [1n] });
    }
  });

  it("refund: refused while open or after completion, and when the wallet has nothing in", async () => {
    await expect(actions(room()).refund.quote({ roomId: "1", token: USDC })).rejects.toThrow(/Refunds open only after/);
    await expect(actions(room({ completedAt: 1n })).refund.quote({ roomId: "1", token: USDC })).rejects.toThrow(/completed/);
    const expired = room({ deadline: NOW - 1n, raised: 5n });
    const q = await actions(expired, { contributed: 0n }).refund.quote({ roomId: "1", token: USDC });
    await expect(actions(expired, { contributed: 0n }).refund.build({ roomId: "1", token: USDC }, q, { wallet: BOB })).rejects.toThrow(/nothing to refund/);
    const steps = await actions(expired, { contributed: 5n }).refund.build({ roomId: "1", token: USDC }, q, { wallet: ALICE });
    expect(decodeFunctionData({ abi: ROOM_ESCROW_ABI, data: steps[0].tx.data })).toMatchObject({ functionName: "refund", args: [1n] });
  });

  it("cancel: creator only, open rooms only", async () => {
    const a = actions(room()).cancel_room;
    const q = await a.quote({ roomId: "1", token: USDC });
    await expect(a.build({ roomId: "1", token: USDC }, q, { wallet: ALICE })).rejects.toThrow(/Only the room's creator/);
    await expect(actions(room({ completedAt: 1n })).cancel_room.quote({ roomId: "1", token: USDC })).rejects.toThrow(/only an open room/);
  });

  it("REGRESSION: rooms can't be created on an escrow configured for the old 0.25% (or anything but 0.5%)", async () => {
    const base = { kind: "target", token: USDC, beneficiary: CREATOR, goal: "1000000000", deadline: String(NOW + 86_400n), termsHash: `0x${"11".repeat(32)}` };
    for (const bps of [25, 0, 49]) {
      await expect(actions(room(), { feeBps: bps }).create_room.quote(base)).rejects.toThrow(/doesn't match PayAI's published 0.5% Rooms fee/);
    }
    const q = await actions(room(), { feeBps: 50 }).create_room.quote(base);
    expect(q.terms?.feeBps).toBe("50");
    expect(q.details["if fully funded"]).toBe("PayAI fee 5 USDC · beneficiary receives 995 USDC");
  });

  it("disclosures say exactly what happens: exact contribution, fee from successful proceeds, full refunds", async () => {
    const q = await actions(room()).contribute.quote({ roomId: "1", amount: "5000000", token: USDC });
    expect(q.details.fee).toBe("You pay exactly this amount. PayAI deducts a 0.5% platform fee from the room's proceeds only if it completes; refunds are 100%.");
    const done = room({ raised: 1_000_000_000n, target: 1_000_000_000n, completedAt: 1n });
    const c = await actions(done).claim.quote({ roomId: "1", token: USDC });
    expect(c.details).toMatchObject({ "PayAI fee (0.5%)": "5 USDC", "beneficiary receives": "995 USDC" });
  });

  it("create_room validates kind, shares, deadline window, token support and terms hash", async () => {
    const a = actions(room()).create_room;
    const base = { kind: "fixed", token: USDC, beneficiary: CREATOR, share: "10000000", slots: "3", goal: "30000000", deadline: String(NOW + 86_400n), termsHash: `0x${"11".repeat(32)}` };
    const q = await a.quote(base);
    expect(q.terms).toMatchObject({ kind: "fixed", target: "30000000", feeBps: "50" });
    const steps = await a.build(base, q);
    expect(decodeFunctionData({ abi: ROOM_ESCROW_ABI, data: steps[0].tx.data }).args).toEqual([0, USDC, CREATOR, 10_000_000n, 3, 30_000_000n, 0n, NOW + 86_400n, `0x${"11".repeat(32)}`]);
    await expect(a.quote({ ...base, goal: "30000001" })).rejects.toThrow(/share times/);
    await expect(a.quote({ ...base, slots: "1" })).rejects.toThrow(/2 to 1000/);
    await expect(a.quote({ ...base, deadline: String(NOW + 600n) })).rejects.toThrow(/too soon/);
    await expect(a.quote({ ...base, deadline: String(NOW + 91n * 86_400n) })).rejects.toThrow(/90 days/);
    await expect(a.quote({ ...base, beneficiary: ESCROW })).rejects.toThrow(/can't receive/);
    await expect(a.quote({ ...base, termsHash: "0x12" })).rejects.toThrow(/terms hash/);
    await expect(actions(room(), { supported: false }).create_room.quote(base)).rejects.toThrow(/doesn't accept USDC/);
    await expect(a.quote({ kind: "target", token: USDC, beneficiary: CREATOR, share: "1", goal: "30", deadline: base.deadline, termsHash: base.termsHash })).rejects.toThrow(/no fixed share/);
  });

  describe("PA-05 platform minimum (0.5 USDC = 500,000 units; 1 MON = 10^18 wei)", () => {
    const dl = String(NOW + 86_400n), th = `0x${"11".repeat(32)}`;
    const fixed = (token: string, share: string) => ({ kind: "fixed", token, beneficiary: CREATOR, share, slots: "2", goal: String(BigInt(share) * 2n), deadline: dl, termsHash: th });
    const target = (token: string, goal: string, minContribution?: string) => ({ kind: "target", token, beneficiary: CREATOR, goal, ...(minContribution ? { minContribution } : {}), deadline: dl, termsHash: th });
    const create = (opts?: Parameters<typeof reader>[1]) => actions(room(), opts).create_room;

    it.each([
      ["USDC", USDC, 500_000n],
      ["MON", NATIVE, 10n ** 18n],
    ] as const)("%s fixed share: below the minimum is refused; at and above are accepted", async (sym, tk, MIN) => {
      await expect(create().quote(fixed(tk, String(MIN - 1n)))).rejects.toThrow(new RegExp(`Each share must be at least ${sym === "USDC" ? "0.5 USDC" : "1 MON"}`));
      expect((await create().quote(fixed(tk, String(MIN)))).terms).toMatchObject({ share: String(MIN) });
      expect((await create().quote(fixed(tk, String(MIN + 1n)))).terms).toMatchObject({ share: String(MIN + 1n) });
    });

    it.each([
      ["USDC", USDC, 500_000n],
      ["MON", NATIVE, 10n ** 18n],
    ] as const)("%s target room: minimum below / at / above; omitted defaults to the platform minimum; target below it refused", async (sym, tk, MIN) => {
      await expect(create().quote(target(tk, String(MIN * 10n), String(MIN - 1n)))).rejects.toThrow(/can't be below/);
      expect((await create().quote(target(tk, String(MIN * 10n), String(MIN)))).terms).toMatchObject({ minContribution: String(MIN) });
      expect((await create().quote(target(tk, String(MIN * 10n), String(MIN + 1n)))).terms).toMatchObject({ minContribution: String(MIN + 1n) });
      const q = await create().quote(target(tk, String(MIN * 10n)));
      expect(q.terms).toMatchObject({ minContribution: String(MIN) });
      const steps = await create().build(target(tk, String(MIN * 10n)), q);
      expect(decodeFunctionData({ abi: ROOM_ESCROW_ABI, data: steps[0].tx.data }).args[6]).toBe(MIN); // what the contract receives
      await expect(create().quote(target(tk, String(MIN - 1n)))).rejects.toThrow(new RegExp(`target must be at least ${sym === "USDC" ? "0.5 USDC" : "1 MON"}`));
    });

    it("fails closed when the live USDC isn't 6 decimals, or the escrow's minimum differs from PayAI's", async () => {
      await expect(create({ decimals: 18 }).quote(target(USDC, "10000000"))).rejects.toThrow(/reports 18 decimals.*assumes 6/);
      await expect(create({ floor: 0n }).quote(target(USDC, "10000000"))).rejects.toThrow(/minimum contribution \(not set\) doesn't match PayAI's 0.5 USDC/);
      await expect(create({ floor: 1_000_000n }).quote(target(USDC, "10000000"))).rejects.toThrow(/doesn't match PayAI's 0.5 USDC/);
      await expect(create({ floor: 1n }).quote(fixed(NATIVE, String(10n ** 18n)))).rejects.toThrow(/doesn't match PayAI's 1 MON/);
    });

    it("contribution errors state the room's minimum and the exact remainder; the exact remainder below the minimum is fine", async () => {
      const r = room({ target: 10_000_000n, minContribution: 500_000n, raised: 9_800_000n }); // 0.2 USDC left
      const c = actions(r).contribute;
      await expect(c.quote({ roomId: "1", amount: "100000", token: USDC })).rejects.toThrow("That's below this room's minimum contribution of 0.5 USDC. Pay at least 0.5 USDC, or exactly the 0.2 USDC still needed.");
      await expect(c.quote({ roomId: "1", amount: "300000", token: USDC })).rejects.toThrow(/more than the room still needs \(0.2 USDC\)/);
      expect((await c.quote({ roomId: "1", amount: "200000", token: USDC })).terms).toMatchObject({ amount: "200000" });
      const open = actions(room({ target: 10_000_000n, minContribution: 500_000n })).contribute;
      await expect(open.quote({ roomId: "1", amount: "499999", token: USDC })).rejects.toThrow(/minimum contribution of 0.5 USDC/);
      expect((await open.quote({ roomId: "1", amount: "500000", token: USDC })).terms).toMatchObject({ amount: "500000" });
      expect((await open.quote({ roomId: "1", amount: "500001", token: USDC })).terms).toMatchObject({ amount: "500001" });
    });

    it("policy helpers: USDC conversion is refused for any decimals but 6", () => {
      expect(roomMinimumUnits({ native: true, decimals: 18 })).toBe(10n ** 18n);
      expect(roomMinimumUnits({ native: false, decimals: 6 })).toBe(500_000n);
      expect(() => roomMinimumUnits({ native: false, decimals: 18 })).toThrow(/6 decimals/);
      expect(ROOM_MIN_CONTRIBUTION_USDC).toBe(500_000n);
      expect(ROOM_MIN_CONTRIBUTION_MON).toBe(1_000_000_000_000_000_000n);
    });
  });
});

/* ── Confirmed outputs: strict ────────────────────────────────────────── */

describe("a confirmed contribution counts only when the escrow's event matches the build exactly", () => {
  const terms = { escrow: ESCROW.toLowerCase(), roomId: "7", token: USDC.toLowerCase(), amount: "5000000", feeBps: "25", beneficiary: CREATOR.toLowerCase() };
  const good = () => log("Contributed", { roomId: 7n, contributor: ALICE, amount: 5_000_000n, raised: 5_000_000n });
  const ctx = { terms, wallet: ALICE.toLowerCase() };
  it("accepts the exact match", () => {
    expect(verifyContribution(receipt([good()]), ESCROW, ctx)?.outputs.amount).toMatchObject({ value: "5000000", token: USDC.toLowerCase() });
  });
  it.each([
    ["another wallet's contribution", [log("Contributed", { roomId: 7n, contributor: BOB, amount: 5_000_000n, raised: 1n })], ctx],
    ["another room", [log("Contributed", { roomId: 8n, contributor: ALICE, amount: 5_000_000n, raised: 1n })], ctx],
    ["a different amount", [log("Contributed", { roomId: 7n, contributor: ALICE, amount: 4_999_999n, raised: 1n })], ctx],
    ["an event from another contract", [log("Contributed", { roomId: 7n, contributor: ALICE, amount: 5_000_000n, raised: 1n }, OTHER)], ctx],
    ["no event", [], ctx],
    ["no build terms", [good()], { wallet: ALICE.toLowerCase() }],
    ["no build wallet", [good()], { terms }],
  ])("refuses %s", (_name, logs, c) => {
    expect(verifyContribution(receipt(logs as ReturnType<typeof log>[]), ESCROW, c)).toBeNull();
  });
  it("refuses a reverted transaction", () => {
    expect(verifyContribution(receipt([good()], "reverted"), ESCROW, ctx)).toBeNull();
  });
  it("claim/refund outputs check the room, beneficiary and contributor", async () => {
    const acts = actions(room());
    const claimTerms = { escrow: ESCROW.toLowerCase(), roomId: "7", token: USDC.toLowerCase(), net: "99", fee: "1", beneficiary: CREATOR.toLowerCase(), treasury: TREASURY.toLowerCase() };
    const claimed = log("Claimed", { roomId: 7n, beneficiary: CREATOR, net: 99n, fee: 1n, treasury: TREASURY });
    expect(await acts.claim.confirmedOutputs!(receipt([claimed]), { terms: claimTerms, wallet: CREATOR.toLowerCase() })).not.toBeNull();
    expect(await acts.claim.confirmedOutputs!(receipt([claimed]), { terms: { ...claimTerms, net: "98" }, wallet: CREATOR.toLowerCase() })).toBeNull();
    const refunded = log("Refunded", { roomId: 7n, contributor: ALICE, amount: 5n });
    const rt = { escrow: ESCROW.toLowerCase(), roomId: "7", token: USDC.toLowerCase() };
    expect(await acts.refund.confirmedOutputs!(receipt([refunded]), { terms: rt, wallet: ALICE.toLowerCase() })).not.toBeNull();
    expect(await acts.refund.confirmedOutputs!(receipt([refunded]), { terms: rt, wallet: BOB.toLowerCase() })).toBeNull();
  });
  it("encodes the ABI the contract artifact declares (selector sanity)", () => {
    expect(encodeAbiParameters([{ type: "uint256" }], [1n])).toMatch(/^0x0+1$/);
  });
});
