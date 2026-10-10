/**
 * Read-only access to the configured PayAIRoomEscrow. The contract is the
 * authority for every escrow Room number the app shows: raised, contributors,
 * status, claimable and refundable amounts are read here, never from KV.
 *
 * Fails closed: with no escrow configured (lib/monad/config.ts
 * getRoomEscrow) every call throws EscrowUnavailableError, and a read that
 * fails is an error — never a zero.
 *
 * Server-only.
 */
import "server-only";
import { getAddress, type Address } from "viem";
import { ROOM_ESCROW_ABI, escrowStatusName, type ChainRoom, type EscrowStatus } from "./escrowChain";

export class EscrowUnavailableError extends Error {}

export async function requireEscrow(): Promise<Address> {
  const { getRoomEscrow } = await import("@/lib/monad/config");
  const a = getRoomEscrow();
  if (!a) throw new EscrowUnavailableError("Escrow Rooms aren't available yet: no reviewed escrow contract is configured.");
  return getAddress(a);
}

async function client() {
  const { getPublicClient } = await import("@/lib/monad/wallet");
  return getPublicClient();
}

async function read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  const escrow = await requireEscrow();
  try {
    return (await (await client()).readContract({ address: escrow, abi: ROOM_ESCROW_ABI, functionName, args } as never)) as T;
  } catch {
    throw new EscrowUnavailableError("Couldn't read the escrow contract. Try again in a moment.");
  }
}

export async function readChainRoom(roomId: bigint): Promise<ChainRoom> {
  const r = await read<Record<string, unknown>>("getRoom", [roomId]);
  return {
    creator: getAddress(r.creator as string), beneficiary: getAddress(r.beneficiary as string), token: getAddress(r.token as string),
    treasury: getAddress(r.treasury as string), kind: Number(r.kind), feeBps: Number(r.feeBps), deadline: BigInt(r.deadline as bigint),
    slots: Number(r.slots), share: r.share as bigint, target: r.target as bigint, minContribution: r.minContribution as bigint,
    termsHash: r.termsHash as `0x${string}`, raised: r.raised as bigint, refunded: r.refunded as bigint,
    contributors: Number(r.contributors), completedAt: BigInt(r.completedAt as bigint), claimed: r.claimed as boolean, cancelled: r.cancelled as boolean,
  };
}

export async function readStatus(roomId: bigint): Promise<EscrowStatus> {
  const s = escrowStatusName(await read<number>("statusOf", [roomId]));
  if (!s) throw new EscrowUnavailableError("The escrow returned an unknown status.");
  return s;
}

export const readContributionOf = (roomId: bigint, who: Address) => read<bigint>("contributionOf", [roomId, who]);
export const readRefundableOf = (roomId: bigint, who: Address) => read<bigint>("refundableOf", [roomId, who]);
export async function readClaimableOf(roomId: bigint): Promise<{ net: bigint; fee: bigint }> {
  const [net, fee] = await read<readonly [bigint, bigint]>("claimableOf", [roomId]);
  return { net, fee };
}
export const readTokenSupported = (token: Address) => read<boolean>("tokenSupported", [token]);
/** The escrow's platform minimum for `token` (PA-05); 0 = not set. */
export const readMinContributionFloor = (token: Address) => read<bigint>("minContributionFloor", [token]);

/** decimals() of an ERC-20, read live — the Rooms minimum (0.5 USDC = 500,000
 *  units) is only valid for a 6-decimal token, so this is checked, not assumed. */
export async function readTokenDecimals(token: Address): Promise<number> {
  try {
    const d = await (await client()).readContract({
      address: token, functionName: "decimals", args: [],
      abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }],
    });
    return Number(d);
  } catch {
    throw new EscrowUnavailableError("Couldn't read the token's decimals. Try again in a moment.");
  }
}
export const readPaused = () => read<boolean>("paused", []);

/** The fee a room created NOW would snapshot. */
export async function readEscrowFeeTerms(): Promise<{ feeBps: number; treasury: Address; escrow: Address }> {
  const [feeBps, treasury] = await Promise.all([read<number>("feeBps", []), read<string>("treasury", [])]);
  const n = Number(feeBps);
  if (!Number.isInteger(n) || n < 0 || n > 50) throw new EscrowUnavailableError("The escrow's fee configuration is invalid.");
  return { feeBps: n, treasury: getAddress(treasury), escrow: await requireEscrow() };
}

/** Current chain time — the clock every escrow rule runs on. */
export async function chainNowSec(): Promise<bigint> {
  try {
    return (await (await client()).getBlock({ blockTag: "latest" })).timestamp;
  } catch {
    throw new EscrowUnavailableError("Couldn't read Monad's current time. Try again in a moment.");
  }
}
