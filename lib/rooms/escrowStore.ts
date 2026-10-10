/**
 * Escrow Rooms — what PayAI keeps off-chain, on the existing Rooms KV
 * (prefix payai:rooms:). The CONTRACT is the authority for money and status;
 * this only holds what the contract can't: the room's text, its link, which
 * plans are in flight, and a log of contributions PayAI itself verified.
 *
 *   escrow:{id}            the room as the creator previewed it (SET NX, never edited)
 *   escrow-chain:{id}      its on-chain identity once its creation receipt
 *                          verified (SET NX — a room is adopted at most once)
 *   escrow-chainid:{n}     which app room adopted on-chain room n (SET NX)
 *   escrow-plan:{id}:{a}:{k}  the wallet's in-flight plan for action k
 *   escrow-log:{id}        verified events (LPUSH), each tx counted once via tx:{hash}
 *   public                 rooms whose creators opted into Live Rooms (LPUSH)
 *   by:{address}           shared with direct rooms — rooms a wallet created or contributed to
 *
 * Server-only.
 */
import "server-only";
import { ROOMS_PREFIX as P, RoomError, roomsBackend } from "./store";
import type { RoomAsset } from "./terms";
import type { EscrowKind } from "./escrowChain";

export interface EscrowRoomRecord {
  id: string;
  mode: "escrow";
  kind: EscrowKind;
  creator: string;
  beneficiary: string;
  beneficiaryLabel: string | null;
  asset: RoomAsset;
  title: string;
  description: string;
  publicListing: boolean;
  /** Base units. share/slots only for "fixed"; minContribution only for "target". */
  shareUnits: string;
  slots: number;
  targetUnits: string;
  minUnits: string;
  /** Unix seconds — the on-chain deadline. */
  deadline: number;
  termsHash: string;
  /** The escrow contract this room was previewed against. */
  escrow: string;
  /** The fee the creator was shown (escrow's feeBps at preview). */
  feeBps: number;
  createdAt: number;
}

export interface EscrowChainRecord { roomId: string; txHash: string; adoptedAt: number }

export type EscrowActionKind = "create" | "contribute" | "claim" | "refund" | "cancel";

export interface EscrowLogEntry {
  kind: "contributed" | "claimed" | "refunded" | "cancelled";
  txHash: string;
  /** Lowercased. Kept server-side; views reveal it only to its owner. */
  actor: string;
  amountUnits: string;
  at: number;
}

const parse = <T>(v: unknown): T | null => (v == null ? null : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const a = (x: string) => x.toLowerCase();
export const ESCROW_ID_RE = /^er_[0-9a-f]{24}$/;

export async function createEscrowRecord(r: EscrowRoomRecord): Promise<void> {
  const b = await roomsBackend();
  if (!(await b.setNx(`${P}escrow:${r.id}`, JSON.stringify(r)))) throw new RoomError("UNAVAILABLE", "Couldn't create the room. Try again.");
  await b.lpush(`${P}by:${a(r.creator)}`, r.id);
}

export async function getEscrowRecord(id: string): Promise<EscrowRoomRecord | null> {
  if (!ESCROW_ID_RE.test(id)) return null;
  return parse<EscrowRoomRecord>(await (await roomsBackend()).get(`${P}escrow:${id}`));
}

export async function getEscrowChain(id: string): Promise<EscrowChainRecord | null> {
  return parse<EscrowChainRecord>(await (await roomsBackend()).get(`${P}escrow-chain:${id}`));
}

/** Adopt on-chain room `roomId` for app room `id` — once each way. */
export async function adoptEscrowChain(id: string, rec: EscrowChainRecord): Promise<boolean> {
  const b = await roomsBackend();
  if (!(await b.setNx(`${P}escrow-chainid:${rec.roomId}`, id))) {
    if ((await b.get(`${P}escrow-chainid:${rec.roomId}`)) !== id) return false;
  }
  await b.setNx(`${P}escrow-chain:${id}`, JSON.stringify(rec));
  const stored = await getEscrowChain(id);
  return stored?.roomId === rec.roomId;
}

export async function getEscrowPlan(id: string, wallet: string, kind: EscrowActionKind): Promise<string | null> {
  const v = await (await roomsBackend()).get(`${P}escrow-plan:${id}:${a(wallet)}:${kind}`);
  return typeof v === "string" ? v : null;
}
export async function setEscrowPlan(id: string, wallet: string, kind: EscrowActionKind, planId: string | null): Promise<void> {
  const b = await roomsBackend();
  if (planId) await b.set(`${P}escrow-plan:${id}:${a(wallet)}:${kind}`, planId);
  else await b.del(`${P}escrow-plan:${id}:${a(wallet)}:${kind}`);
}

/** Record a verified event; a transaction is logged once, globally. False if
 *  that transaction was already counted for something else. */
export async function logEscrowEvent(id: string, e: EscrowLogEntry): Promise<boolean> {
  const b = await roomsBackend();
  const owner = `${id}:${e.kind}:${a(e.actor)}`;
  if (!(await b.setNx(`${P}tx:${a(e.txHash)}`, owner))) return (await b.get(`${P}tx:${a(e.txHash)}`)) === owner;
  await b.lpush(`${P}escrow-log:${id}`, JSON.stringify({ ...e, txHash: a(e.txHash), actor: a(e.actor) }));
  if (e.kind === "contributed") await b.lpush(`${P}by:${a(e.actor)}`, id);
  return true;
}

export async function readEscrowLog(id: string, limit = 200): Promise<EscrowLogEntry[]> {
  const raw = await (await roomsBackend()).lrange(`${P}escrow-log:${id}`, 0, limit - 1);
  const seen = new Set<string>();
  const out: EscrowLogEntry[] = [];
  for (const r of raw) {
    const e = parse<EscrowLogEntry>(r);
    if (!e || seen.has(e.txHash)) continue; // never count one transaction twice
    seen.add(e.txHash);
    out.push(e);
  }
  return out.sort((x, y) => x.at - y.at);
}

export async function listPublicIds(limit = 100): Promise<string[]> {
  const ids = await (await roomsBackend()).lrange(`${P}public`, 0, limit - 1);
  return [...new Set(ids)];
}
export async function addPublic(id: string): Promise<void> {
  await (await roomsBackend()).lpush(`${P}public`, id);
}
