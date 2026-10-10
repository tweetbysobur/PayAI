/**
 * PayAIRoomEscrow — the app's one description of the contract
 * (contracts/contracts/PayAIRoomEscrow.sol): its ABI, its status codes, its
 * fee math, the terms hash that binds a room's off-chain text on-chain, and
 * strict decoders for its events.
 *
 * Pure: no I/O, no clock, no env. Used by the SDK actions
 * (lib/sdk/actions/room-escrow) and the Rooms service, and unit-tested
 * directly (test/room-escrow-chain.test.ts).
 *
 * Every decoder accepts ONLY events emitted by the given escrow address and
 * returns null unless there is EXACTLY one matching event — an absent,
 * duplicated, foreign-address or malformed event never counts.
 */
import { decodeEventLog, getAddress, keccak256, toHex, type Address, type Hex } from "viem";

export const ROOM_ESCROW_ABI = [
  {
    type: "function", name: "createRoom", stateMutability: "nonpayable",
    inputs: [
      { name: "kind", type: "uint8" }, { name: "token", type: "address" }, { name: "beneficiary", type: "address" },
      { name: "share", type: "uint256" }, { name: "slots", type: "uint32" }, { name: "target", type: "uint256" },
      { name: "minContribution", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "termsHash", type: "bytes32" },
    ],
    outputs: [{ name: "roomId", type: "uint256" }],
  },
  { type: "function", name: "contribute", stateMutability: "payable", inputs: [{ name: "roomId", type: "uint256" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "roomId", type: "uint256" }], outputs: [] },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ name: "roomId", type: "uint256" }], outputs: [] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "roomId", type: "uint256" }], outputs: [] },
  {
    type: "function", name: "getRoom", stateMutability: "view", inputs: [{ name: "roomId", type: "uint256" }],
    outputs: [{
      name: "", type: "tuple", components: [
        { name: "creator", type: "address" }, { name: "beneficiary", type: "address" }, { name: "token", type: "address" },
        { name: "treasury", type: "address" }, { name: "kind", type: "uint8" }, { name: "feeBps", type: "uint16" },
        { name: "deadline", type: "uint64" }, { name: "slots", type: "uint32" }, { name: "share", type: "uint256" },
        { name: "target", type: "uint256" }, { name: "minContribution", type: "uint256" }, { name: "termsHash", type: "bytes32" },
        { name: "raised", type: "uint256" }, { name: "refunded", type: "uint256" }, { name: "contributors", type: "uint32" },
        { name: "completedAt", type: "uint64" }, { name: "claimed", type: "bool" }, { name: "cancelled", type: "bool" },
      ],
    }],
  },
  { type: "function", name: "statusOf", stateMutability: "view", inputs: [{ name: "roomId", type: "uint256" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "contributionOf", stateMutability: "view", inputs: [{ name: "roomId", type: "uint256" }, { name: "who", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimableOf", stateMutability: "view", inputs: [{ name: "roomId", type: "uint256" }], outputs: [{ name: "net", type: "uint256" }, { name: "fee", type: "uint256" }] },
  { type: "function", name: "refundableOf", stateMutability: "view", inputs: [{ name: "roomId", type: "uint256" }, { name: "who", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenSupported", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "MAX_FEE_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "recoverFees", stateMutability: "nonpayable", inputs: [{ name: "fromTreasury", type: "address" }, { name: "token", type: "address" }], outputs: [] },
  { type: "function", name: "minContributionFloor", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setMinContributionFloor", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "feesOwed", stateMutability: "view", inputs: [{ name: "treasury", type: "address" }, { name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "event", name: "RoomCreated", inputs: [
      { name: "roomId", type: "uint256", indexed: true }, { name: "creator", type: "address", indexed: true },
      { name: "beneficiary", type: "address", indexed: true }, { name: "token", type: "address", indexed: false },
      { name: "kind", type: "uint8", indexed: false }, { name: "share", type: "uint256", indexed: false },
      { name: "slots", type: "uint32", indexed: false }, { name: "target", type: "uint256", indexed: false },
      { name: "minContribution", type: "uint256", indexed: false }, { name: "deadline", type: "uint64", indexed: false },
      { name: "feeBps", type: "uint16", indexed: false }, { name: "treasury", type: "address", indexed: false },
      { name: "termsHash", type: "bytes32", indexed: false },
    ],
  },
  { type: "event", name: "Contributed", inputs: [{ name: "roomId", type: "uint256", indexed: true }, { name: "contributor", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "raised", type: "uint256", indexed: false }] },
  { type: "event", name: "RoomCompleted", inputs: [{ name: "roomId", type: "uint256", indexed: true }, { name: "raised", type: "uint256", indexed: false }] },
  // `beneficiary` here is the contract's `to`: where the net payout went (the
  // room's beneficiary for claim(); a beneficiary-chosen address for claimTo()).
  { type: "event", name: "Claimed", inputs: [{ name: "roomId", type: "uint256", indexed: true }, { name: "beneficiary", type: "address", indexed: true }, { name: "net", type: "uint256", indexed: false }, { name: "fee", type: "uint256", indexed: false }, { name: "treasury", type: "address", indexed: false }] },
  { type: "event", name: "Refunded", inputs: [{ name: "roomId", type: "uint256", indexed: true }, { name: "contributor", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "RoomCancelled", inputs: [{ name: "roomId", type: "uint256", indexed: true }] },
  { type: "event", name: "MinContributionFloorSet", inputs: [{ name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "FeesRecovered", inputs: [{ name: "fromTreasury", type: "address", indexed: true }, { name: "toTreasury", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
] as const;

export const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
export const ESCROW_KIND = { fixed: 0, target: 1 } as const;
export type EscrowKind = keyof typeof ESCROW_KIND;
/** PayAI Rooms platform fee: 0.5% (50 bps) of a SUCCESSFUL room's proceeds,
 *  deducted from the payout. Separate from the forwarder's payment fee. The
 *  contract's MAX_FEE_BPS is also 50, and the app refuses to create rooms on
 *  an escrow configured for anything else (so a stale 0.25% can't slip in). */
export const ROOM_FEE_BPS = 50;
export const MAX_ESCROW_FEE_BPS = 50;
/** "0.5%" from 50 bps — the way the fee is written everywhere. */
export function feePercent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}
/**
 * PA-05 — PayAI Rooms' platform minimum contribution (approved 2026-10-10),
 * in base units. A contribution minimum, not a gas reserve. Applies to both
 * room kinds: a fixed share, and a target room's minimum, must be at least
 * this. The exact remainder of a target room is always accepted, even below
 * it, so a valid room can always complete. Mirrors the escrow's
 * minContributionFloor(token); the app refuses to create rooms if they differ.
 */
export const ROOM_MIN_CONTRIBUTION_MON = 10n ** 18n; // 1 MON
export const ROOM_MIN_CONTRIBUTION_USDC = 500_000n; // 0.5 USDC — valid ONLY for a 6-decimal USDC
export const ROOM_USDC_DECIMALS = 6;

/** The platform minimum for a room token, in base units. Throws for a
 *  non-native token whose decimals aren't 6: the 0.5 USDC = 500,000 units
 *  conversion would be wrong, so nothing may rely on it. */
export function roomMinimumUnits(t: { native: boolean; decimals: number }): bigint {
  if (t.native) return ROOM_MIN_CONTRIBUTION_MON;
  if (t.decimals !== ROOM_USDC_DECIMALS) throw new Error(`USDC must have ${ROOM_USDC_DECIMALS} decimals for the Rooms minimum; this token reports ${t.decimals}.`);
  return ROOM_MIN_CONTRIBUTION_USDC;
}

/** The platform minimum as people read it ("0.5 USDC", "1 MON"), by symbol;
 *  null for anything else. Display only — enforcement is roomMinimumUnits,
 *  the service/SDK checks and the contract. */
export function roomMinimumText(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  return s === "MON" ? "1 MON" : s === "USDC" ? "0.5 USDC" : null;
}

/** Why these terms break the platform minimum (null when they don't). Same
 *  rules as the contract's createRoom; `show` formats base units. */
export function roomMinimumProblem(kind: EscrowKind, a: { share: bigint; target: bigint; min: bigint }, floor: bigint, show: (u: bigint) => string): string | null {
  if (kind === "fixed") return a.share < floor ? `Each share must be at least ${show(floor)} — PayAI Rooms' minimum contribution.` : null;
  if (a.target < floor) return `The target must be at least ${show(floor)} — PayAI Rooms' minimum contribution.`;
  if (a.min < floor) return `The minimum contribution can't be below ${show(floor)} — PayAI Rooms' platform minimum.`;
  return null;
}

/** The contract's own bounds (immutable constants). */
export const ESCROW_LIMITS = { minSlots: 2, maxSlots: 1000, minDurationSec: 3600, maxDurationSec: 90 * 86400 } as const;

/** statusOf() codes → names. */
export const ESCROW_STATUS = ["none", "open", "completed", "claimed", "expired", "cancelled"] as const;
export type EscrowStatus = (typeof ESCROW_STATUS)[number];
export function escrowStatusName(code: number | bigint): EscrowStatus | null {
  const n = Number(code);
  return Number.isInteger(n) && n >= 0 && n < ESCROW_STATUS.length ? ESCROW_STATUS[n] : null;
}

/** The room as the contract stores it. */
export interface ChainRoom {
  creator: Address; beneficiary: Address; token: Address; treasury: Address;
  kind: number; feeBps: number; deadline: bigint; slots: number;
  share: bigint; target: bigint; minContribution: bigint; termsHash: Hex;
  raised: bigint; refunded: bigint; contributors: number; completedAt: bigint;
  claimed: boolean; cancelled: boolean;
}

/**
 * Status exactly as the contract derives it (statusOf), from a ChainRoom and
 * a block timestamp. Used to check the contract's answer, and to evaluate
 * boundaries in tests — never instead of reading the contract.
 */
export function deriveEscrowStatus(r: Pick<ChainRoom, "creator" | "claimed" | "completedAt" | "cancelled" | "deadline">, nowSec: bigint): EscrowStatus {
  if (r.creator.toLowerCase() === NATIVE) return "none";
  if (r.claimed) return "claimed";
  if (r.completedAt !== 0n) return "completed";
  if (r.cancelled) return "cancelled";
  if (nowSec >= r.deadline) return "expired";
  return "open";
}

/** floor(raised * feeBps / 10000) — the contract's exact claim fee. */
export function escrowClaimFee(raised: bigint, feeBps: number): { fee: bigint; net: bigint } {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_ESCROW_FEE_BPS) throw new Error("invalid escrow fee");
  const fee = (raised * BigInt(feeBps)) / 10000n;
  return { fee, net: raised - fee };
}

/**
 * What the contract would accept as a contribution right now (amount rules
 * only; status and deadline are separate). Mirrors contribute() exactly.
 */
export function contributionProblem(r: Pick<ChainRoom, "kind" | "share" | "target" | "raised" | "minContribution">, amount: bigint, alreadyContributed: bigint, show?: (u: bigint) => string): string | null {
  if (amount <= 0n) return "The amount must be more than zero.";
  const remaining = r.target - r.raised;
  if (r.kind === ESCROW_KIND.fixed) {
    if (alreadyContributed > 0n) return "You've already paid your share in this room.";
    if (amount !== r.share) return show ? `This room takes exactly one share of ${show(r.share)} per person.` : "This room takes exactly one share per person.";
    return null;
  }
  if (amount > remaining) return show ? `That's more than the room still needs (${show(remaining)}).` : "That's more than the room still needs.";
  if (amount < r.minContribution && amount !== remaining) {
    return show
      ? `That's below this room's minimum contribution of ${show(r.minContribution)}. Pay at least ${show(r.minContribution)}, or exactly the ${show(remaining)} still needed.`
      : "That's below this room's minimum contribution. Pay at least the minimum, or exactly what's still needed.";
  }
  return null;
}

/* ── Terms hash ──────────────────────────────────────────────────────── */

/** The off-chain text the creator agreed to, bound on-chain at creation. */
export interface RoomMetadata { title: string; description: string; publicListing: boolean }

/** keccak256 of the canonical JSON of the metadata — key order fixed. */
export function roomTermsHash(m: RoomMetadata): Hex {
  return keccak256(toHex(JSON.stringify({ v: 1, title: m.title, description: m.description, publicListing: m.publicListing })));
}

/* ── Event decoders ──────────────────────────────────────────────────── */

export interface ReceiptLike { status: "success" | "reverted" | string; logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] }

type EventName = "RoomCreated" | "Contributed" | "RoomCompleted" | "Claimed" | "Refunded" | "RoomCancelled";

/** Every event `name` emitted BY `escrow` in these logs (undecodable logs skipped). */
function eventsOf(logs: ReceiptLike["logs"], escrow: string, name: EventName): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of logs) {
    if (typeof l?.address !== "string" || l.address.toLowerCase() !== escrow.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: ROOM_ESCROW_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
      if (ev.eventName === name) out.push(ev.args as Record<string, unknown>);
    } catch { /* not one of ours */ }
  }
  return out;
}

function single(receipt: ReceiptLike | null | undefined, escrow: string, name: EventName): Record<string, unknown> | null {
  if (!receipt || receipt.status !== "success" || !Array.isArray(receipt.logs)) return null;
  const evs = eventsOf(receipt.logs, escrow, name);
  return evs.length === 1 ? evs[0] : null;
}

export interface RoomCreatedEvent {
  roomId: bigint; creator: Address; beneficiary: Address; token: Address; kind: number; share: bigint; slots: number;
  target: bigint; minContribution: bigint; deadline: bigint; feeBps: number; treasury: Address; termsHash: Hex;
}
export function decodeRoomCreated(receipt: ReceiptLike | null | undefined, escrow: string): RoomCreatedEvent | null {
  const a = single(receipt, escrow, "RoomCreated");
  if (!a) return null;
  return {
    roomId: a.roomId as bigint, creator: getAddress(a.creator as string), beneficiary: getAddress(a.beneficiary as string),
    token: getAddress(a.token as string), kind: Number(a.kind), share: a.share as bigint, slots: Number(a.slots),
    target: a.target as bigint, minContribution: a.minContribution as bigint, deadline: BigInt(a.deadline as bigint),
    feeBps: Number(a.feeBps), treasury: getAddress(a.treasury as string), termsHash: a.termsHash as Hex,
  };
}

export interface ContributedEvent { roomId: bigint; contributor: Address; amount: bigint; raised: bigint }
export function decodeContributed(receipt: ReceiptLike | null | undefined, escrow: string): ContributedEvent | null {
  const a = single(receipt, escrow, "Contributed");
  if (!a) return null;
  return { roomId: a.roomId as bigint, contributor: getAddress(a.contributor as string), amount: a.amount as bigint, raised: a.raised as bigint };
}

export interface ClaimedEvent { roomId: bigint; beneficiary: Address; net: bigint; fee: bigint; treasury: Address }
export function decodeClaimed(receipt: ReceiptLike | null | undefined, escrow: string): ClaimedEvent | null {
  const a = single(receipt, escrow, "Claimed");
  if (!a) return null;
  return { roomId: a.roomId as bigint, beneficiary: getAddress(a.beneficiary as string), net: a.net as bigint, fee: a.fee as bigint, treasury: getAddress(a.treasury as string) };
}

export interface RefundedEvent { roomId: bigint; contributor: Address; amount: bigint }
export function decodeRefunded(receipt: ReceiptLike | null | undefined, escrow: string): RefundedEvent | null {
  const a = single(receipt, escrow, "Refunded");
  if (!a) return null;
  return { roomId: a.roomId as bigint, contributor: getAddress(a.contributor as string), amount: a.amount as bigint };
}

export function decodeCancelled(receipt: ReceiptLike | null | undefined, escrow: string): { roomId: bigint } | null {
  const a = single(receipt, escrow, "RoomCancelled");
  return a ? { roomId: a.roomId as bigint } : null;
}

/** A room id as the app writes it: a uint256 decimal string, no leading zeros. */
export const CHAIN_ROOM_ID_RE = /^(0|[1-9][0-9]{0,30})$/;
