import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import type { EscrowReader } from "@/lib/sdk/actions/room-escrow";
import type { ChainRoom } from "@/lib/rooms/escrowChain";

/**
 * Escrow Rooms inside the app's existing architecture.
 *
 * Real: the Plan Service, validator, planner, review and approval guard (with
 * the in-memory Plan Store), the payai-rooms protocol registered into the real
 * SDK registry, Ask's deterministic room intent, host routing and the
 * return-path guard. Injected: the escrow's chain reads (no RPC) — so nothing
 * here is evidence of on-chain behaviour.
 */

const ESCROW = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
const USDC = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const WALLET = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const AUTH = { wallet: WALLET };
const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_ROOM_ESCROW", "PAYAI_ROOM_ESCROW_ENABLED"] as const;
let saved: Record<string, string | undefined>;

const ROOM: ChainRoom = {
  creator: WALLET, beneficiary: WALLET, token: getAddress(USDC), treasury: WALLET, kind: 1, feeBps: 50, deadline: 1n << 40n, slots: 0,
  share: 0n, target: 10_000_000n, minContribution: 0n, termsHash: `0x${"00".repeat(32)}`, raised: 0n, refunded: 0n, contributors: 0,
  completedAt: 0n, claimed: false, cancelled: false,
};
const reader = async (): Promise<EscrowReader> => ({
  room: async () => ROOM, contributionOf: async () => 0n, tokenSupported: async () => true,
  feeTerms: async () => ({ feeBps: 50, treasury: WALLET }), paused: async () => false, nowSec: async () => 1_800_000_000n,
  minContributionFloor: async (t: string) => (/^0x0+$/.test(t) ? 10n ** 18n : 500_000n), tokenDecimals: async () => 6,
});

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  delete process.env.MONAD_MAINNET_ROOM_ESCROW;
  delete process.env.PAYAI_ROOM_ESCROW_ENABLED;
  (await import("@/lib/plan/store")).__resetPlanStoreForTests();
  const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  const { createRoomEscrowProtocol } = await import("@/lib/sdk/actions/room-escrow");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
  registerProtocol(createRoomEscrowProtocol(ESCROW, reader, 143)!);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const lit = (value: string) => ({ kind: "literal", value });
const draft = (actionId: string, inputs: Record<string, unknown>, text: string) => ({
  id: "intent_escrow_0001", version: 1, chainId: 143, wallet: WALLET, status: "draft",
  source: { text, adapter: "deterministic", adapterVersion: "rooms-escrow-1" },
  nodes: [{ nodeId: "n1", ref: { protocolId: "payai-rooms", actionId, version: "1.0.0" }, inputs, dependsOn: [], validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" } }],
});
async function review(d: unknown) {
  const svc = await import("@/lib/plan/service");
  const plan = await svc.createPlan(AUTH, d);
  return (await svc.getPlanWithReview(AUTH, plan.planId)).review;
}

describe("escrow actions run through the existing plan → review → approve path", () => {
  it("a contribution plan is reviewable and approvable, described exactly", async () => {
    const r = await review(draft("contribute", { roomId: lit("7"), amount: lit("5000000"), token: lit(USDC) }, "contribute 5 USDC to escrow room er_x"));
    expect(r.reviewable).toBe(true);
    expect(r.steps[0]).toMatchObject({ action: "room_escrow", op: "contribute", roomId: "7", amount: { decimal: "5", symbol: "USDC" }, fee: { rule: "escrow_claim_fee", maxBps: 50 } });
    const svc = await import("@/lib/plan/service");
    const plans = await svc.listPlans(AUTH);
    await expect(svc.approvePlan(AUTH, plans[0].planId)).resolves.toBeTruthy();
  });

  it("create_room plans name the beneficiary as a provenance-checked recipient", async () => {
    const inputs = {
      kind: lit("fixed"), token: lit(USDC), beneficiary: { kind: "recipient", display: WALLET, source: "address", address: WALLET },
      share: lit("10"), slots: lit("3"), goal: lit("30"), deadline: lit("1800100000"), termsHash: lit(`0x${"11".repeat(32)}`),
    };
    const r = await review(draft("create_room", inputs, `create escrow room er_x for 30 USDC paid to ${WALLET}`));
    expect(r.reviewable).toBe(true);
    expect(r.steps[0]).toMatchObject({ action: "room_escrow", op: "create", create: { roomKind: "fixed", slots: 3, beneficiary: { address: WALLET } } });
    // A beneficiary the source text doesn't contain is refused (recipient provenance).
    await expect(review(draft("create_room", inputs, "create escrow room er_x"))).rejects.toMatchObject({ code: "INVALID_PLAN" });
  });

  it("the validator keeps refusing smuggled transaction fields — escrow inputs avoid them", async () => {
    await expect(review(draft("create_room", { target: lit("30") }, "x"))).rejects.toThrow(/"target" is not allowed/);
    const src = readFileSync(new URL("../lib/sdk/actions/room-escrow/index.ts", import.meta.url), "utf8");
    const schemaKeys = [...src.matchAll(/^\s{6}(\w+): \{ type: "/gm)].map((m) => m[1]);
    for (const k of ["to", "target", "data", "spender", "approval", "tx", "value"]) expect(schemaKeys).not.toContain(k);
  });

  it("claim, refund and cancel plans are reviewable with no amount invented", async () => {
    for (const a of ["claim", "refund", "cancel_room"]) {
      (await import("@/lib/plan/store")).__resetPlanStoreForTests();
      const r = await review(draft(a, { roomId: lit("7"), token: lit(USDC) }, `${a} escrow room er_x`));
      expect(r.reviewable).toBe(true);
      expect(r.steps[0]).toMatchObject({ action: "room_escrow", amount: null });
    }
  });

  it("an unknown input on an escrow step makes the plan unreviewable (so unapprovable)", async () => {
    await expect(review(draft("contribute", { roomId: lit("7"), amount: lit("5"), token: lit(USDC), memo: lit("x") }, "contribute"))).rejects.toMatchObject({ code: "INVALID_PLAN" });
  });
});

describe("the escrow fee is separate from the forwarder fee", () => {
  it("a transfer plan still shows the forwarder's own fee rule; escrow steps show the 0.5% Rooms fee", async () => {
    const src = readFileSync(new URL("../lib/plan/review.ts", import.meta.url), "utf8");
    expect(src).toMatch(/rule: "deducted_from_amount", maxBps: config\.maxPlatformFeeBps/);
    expect(src).toMatch(/rule: "escrow_claim_fee" as const, maxBps: MAX_ESCROW_FEE_BPS/);
    const sdk = readFileSync(new URL("../lib/sdk/actions/room-escrow/index.ts", import.meta.url), "utf8");
    expect(sdk).not.toMatch(/getPayAIForwarder|readPlatformFeeTerms|forwardPayment/);
  });
});

describe("availability is fail-closed", () => {
  it("no escrow configured → unavailable, with the reason the UI shows", async () => {
    const { escrowAvailability } = await import("@/lib/rooms/escrowService");
    const a = await escrowAvailability();
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/hasn't been deployed/);
  });
  it("an address without the enable flag is still unavailable; testnet never", async () => {
    const { getRoomEscrow } = await import("@/lib/monad/config");
    process.env.MONAD_MAINNET_ROOM_ESCROW = ESCROW;
    expect(getRoomEscrow()).toBeNull();
    process.env.PAYAI_ROOM_ESCROW_ENABLED = "true";
    expect(getRoomEscrow()?.toLowerCase()).toBe(ESCROW.toLowerCase());
    process.env.MONAD_NETWORK = "testnet";
    expect(getRoomEscrow()).toBeNull();
  });
  it("escrow actions refuse when unavailable — nothing is simulated", async () => {
    const svc = await import("@/lib/rooms/escrowService");
    await expect(svc.previewEscrowRoom(WALLET, { kind: "target", token: "USDC", amount: "10", durationDays: 3, title: "Test room", description: "", publicListing: false }))
      .rejects.toMatchObject({ code: "ESCROW_UNAVAILABLE" });
    await expect(svc.startEscrowAction("er_000000000000000000000000", WALLET, "contribute", "1")).rejects.toMatchObject({ code: "ESCROW_UNAVAILABLE" });
    await expect(svc.listPublicRooms()).rejects.toMatchObject({ code: "ESCROW_UNAVAILABLE" });
  });
});

describe("Ask PayAI uses the same room services", () => {
  it("recognises escrow ids and shared links without inventing anything", async () => {
    const { detectRoomAction } = await import("@/lib/ask/intent/roomIntent");
    const id = "er_0123456789abcdef01234567";
    expect(detectRoomAction(`contribute to ${id}`)).toEqual({ action: "contribute", roomId: id });
    expect(detectRoomAction(`how is https://app.usepayai.xyz/r/${id} doing?`)).toEqual({ action: "status", roomId: id });
    expect(detectRoomAction(`join ${id}`)).toEqual({ action: "join", roomId: id });
    expect(detectRoomAction("pay my share")).toEqual({ action: "contribute", roomId: null });
  });
  it("the Ask escrow card calls the same client functions as the room page and never sends an amount it didn't get typed", () => {
    const card = readFileSync(new URL("../components/ask/EscrowRoomAskCard.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../components/rooms/escrow/EscrowRoom.tsx", import.meta.url), "utf8");
    for (const fn of ["getEscrowRoom", "startEscrowAction", "confirmEscrowAction"]) { expect(card).toContain(fn); expect(page).toContain(fn); }
    expect(card).toMatch(/startEscrowAction\(id, "contribute", room!\.kind === "target" \? amount\.trim\(\) : undefined\)/);
    expect(card).not.toMatch(/sendTransaction|signMessage/);
  });
});

describe("shared links and onboarding return", () => {
  it("only PayAI's own room and dashboard paths are accepted as a return path", async () => {
    const { safeReturnPath } = await import("@/lib/platform/returnPath");
    expect(safeReturnPath("/r/er_0123456789abcdef01234567")).toBe("/r/er_0123456789abcdef01234567");
    expect(safeReturnPath("/rooms")).toBe("/rooms");
    expect(safeReturnPath("/dashboard/rooms")).toBe("/dashboard/rooms");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "/r/er_xyz", "/r/../../x", "javascript:alert(1)", "/dashboard?x=//evil", null, undefined, "/r/" + "a".repeat(300)]) {
      expect(safeReturnPath(bad as string | null)).toBeNull();
    }
  });
  it("room pages are app pages (the wallet session lives on the app host)", async () => {
    const { hostAction, isAppPath } = await import("@/lib/hosts");
    expect(isAppPath("/r/er_0123456789abcdef01234567")).toBe(true);
    expect(isAppPath("/rooms")).toBe(true);
    expect(hostAction("marketing", "/r/er_0123456789abcdef01234567").type).toBe("redirect");
  });
});

describe("honest copy", () => {
  it("never claims escrow where there is none, and states the conditions where there is", () => {
    const direct = readFileSync(new URL("../app/dashboard/rooms/page.tsx", import.meta.url), "utf8");
    expect(direct).toMatch(/no escrow/);
    const svc = readFileSync(new URL("../lib/rooms/escrowService.ts", import.meta.url), "utf8");
    expect(svc).toMatch(/held by the PayAI Room escrow contract — not by PayAI and not by the creator/);
    expect(svc).toMatch(/full refund \(no fee\)/);
    const page = readFileSync(new URL("../components/rooms/escrow/EscrowRoom.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/A pending transaction is never counted/);
    expect(page).not.toMatch(/guaranteed/i);
  });

  it("discloses the cancellation policy before contributing, and that anyone may release a completed room to its beneficiary only", () => {
    const svc = readFileSync(new URL("../lib/rooms/escrowService.ts", import.meta.url), "utf8");
    expect(svc).toMatch(/The creator can cancel the room at any time before it completes\. Once it has completed, it can't be cancelled\./);
    expect(svc).toMatch(/anyone can release the payout — it always goes to/);
    expect(svc).not.toMatch(/isClaimer/);
    const page = readFileSync(new URL("../components/rooms/escrow/EscrowRoom.tsx", import.meta.url), "utf8");
    // The contribute form repeats the cancellation policy next to the amount.
    expect(page).toMatch(/The creator can cancel before the room completes; if that happens, or the deadline passes, you can take your contribution back in full\./);
    expect(page).toMatch(/you receive nothing and only pay network gas/);
    const sdk = readFileSync(new URL("../lib/sdk/actions/room-escrow/index.ts", import.meta.url), "utf8");
    expect(sdk).not.toMatch(/creator or beneficiary/);
  });

  it("PA-05: the creation form, room page and Ask card state the minimum and the exact-remainder exception", async () => {
    const { roomMinimumText } = await import("@/lib/rooms/escrowChain");
    expect([roomMinimumText("USDC"), roomMinimumText("mon"), roomMinimumText("A-USDC")]).toEqual(["0.5 USDC", "1 MON", null]);
    const form = readFileSync(new URL("../components/rooms/escrow/EscrowCreateForm.tsx", import.meta.url), "utf8");
    expect(form).toMatch(/Each share must be at least \$\{platformMin\} — PayAI Rooms' minimum contribution\./);
    expect(form).toMatch(/except the final amount that completes the room/);
    expect(form).not.toMatch(/placeholder="None"/);
    const page = readFileSync(new URL("../components/rooms/escrow/EscrowRoom.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/or exactly the amount still needed, if that's less/);
    const ask = readFileSync(new URL("../components/ask/EscrowRoomAskCard.tsx", import.meta.url), "utf8");
    expect(ask).toMatch(/at least \$\{room\.minContribution\} unless it's exactly the amount still needed/);
  });
});
