/**
 * PayAI Rooms — persistence on the existing KV (lib/platform/kv.ts).
 *
 * Shape (prefix payai:rooms:):
 *   room:{id}          the room's terms — written once (SET NX), never edited
 *   cancel:{id}        the cancellation — written once (SET NX)
 *   p:{id}:{address}   one participant: created by the join (SET NX, so an
 *                      address joins at most once), then updated only by
 *                      that participant's own requests
 *   count:{id}         join counter (INCR) — capacity, atomically
 *   slot:{id}:{n}      the address that took slot n
 *   by:{address}       rooms this wallet created or joined (LPUSH)
 *   tx:{hash}          which room/participant a transaction was counted for
 *                      (SET NX) — a hash counts once, globally
 *   lock:{id}:{addr}   a short lock around starting a payment (SET NX EX)
 *
 * There is no stored status: it is derived from these facts on every read
 * (lib/rooms/terms.ts deriveStatus), so it can't be raced or rewound.
 *
 * In production without KV every call is UNAVAILABLE — rooms never fall back
 * to process memory there. Elsewhere an in-memory equivalent is used.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "@/lib/platform/kv";
import type { RoomAsset } from "./terms";

export interface RoomRecord {
  id: string;
  creator: string;
  recipient: string;
  /** The name the creator gave the recipient (.nad), for display; null for an address. */
  recipientLabel: string | null;
  asset: RoomAsset;
  totalUnits: string;
  shareUnits: string;
  target: number;
  memo: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface ParticipantRecord {
  address: string;
  slot: number;
  joinedAt: number;
  payment: {
    /** The plan the room created for this participant's share. */
    planId: string | null;
    planCreatedAt: number | null;
    txHash: string | null;
    confirmedAt: number | null;
  };
}

export class RoomError extends Error {
  constructor(public code: RoomErrorCode, message: string) { super(message); }
}
export type RoomErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "UNAVAILABLE" | "UNSUPPORTED_ASSET" | "FULL" | "ALREADY_JOINED" | "NOT_JOINED"
  | "CLOSED" | "ALREADY_PAID" | "IN_FLIGHT" | "NOT_CREATOR" | "NOT_CANCELLABLE" | "PAYMENT_UNAVAILABLE"
  | "NOT_SETTLED" | "MISMATCH" | "TX_ALREADY_COUNTED" | "BUSY" | "RECIPIENT_CANNOT_JOIN"
  | "ESCROW_UNAVAILABLE" | "NOT_LIVE" | "NOT_ELIGIBLE";

interface Backend {
  get(key: string): Promise<unknown>;
  setNx(key: string, value: unknown, ex?: number): Promise<boolean>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  lpush(key: string, value: string): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

const P = "payai:rooms:";
const g = globalThis as unknown as { __payaiRooms?: Map<string, { v: unknown; exp: number | null }> };
const mem = (g.__payaiRooms ??= new Map());

function memBackend(): Backend {
  const live = (k: string) => {
    const e = mem.get(k);
    if (e && e.exp != null && e.exp <= Date.now()) { mem.delete(k); return undefined; }
    return e;
  };
  return {
    async get(k) { return structuredClone(live(k)?.v ?? null); },
    async setNx(k, v, ex) { if (live(k)) return false; mem.set(k, { v: structuredClone(v), exp: ex ? Date.now() + ex * 1000 : null }); return true; },
    async set(k, v) { mem.set(k, { v: structuredClone(v), exp: null }); },
    async del(k) { mem.delete(k); },
    async incr(k) { const n = Number(live(k)?.v ?? 0) + 1; mem.set(k, { v: n, exp: null }); return n; },
    async lpush(k, v) { const l = (live(k)?.v as string[] | undefined) ?? []; mem.set(k, { v: [v, ...l], exp: null }); },
    async lrange(k, s, e) { const l = (live(k)?.v as string[] | undefined) ?? []; return l.slice(s, e < 0 ? undefined : e + 1); },
  };
}

async function backend(): Promise<Backend> {
  const r = await getRedis();
  if (r) {
    return {
      get: (k) => r.get(k),
      async setNx(k, v, ex) { return (await r.set(k, v, ex ? { nx: true, ex } : { nx: true })) != null; },
      async set(k, v) { await r.set(k, v); },
      async del(k) { await r.del(k); },
      incr: (k) => r.incr(k),
      async lpush(k, v) { await r.lpush(k, v); },
      // @upstash/redis auto-parses JSON members; keep them as JSON text so
      // callers always get strings (String() would yield "[object Object]").
      async lrange(k, s, e) { return (await r.lrange(k, s, e)).map((v) => (typeof v === "string" ? v : JSON.stringify(v))); },
    };
  }
  if (process.env.NODE_ENV === "production") throw new RoomError("UNAVAILABLE", "Rooms are unavailable right now. Try again in a moment.");
  return memBackend();
}

/** The same KV (and the same production fail-closed rule) for the escrow
 *  Rooms store (lib/rooms/escrowStore.ts). */
export const roomsBackend = backend;
export type RoomsBackend = Backend;
export const ROOMS_PREFIX = P;

const parse = <T>(v: unknown): T | null => (v == null ? null : typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const addrKey = (a: string) => a.toLowerCase();

export async function createRoomRecord(room: RoomRecord): Promise<void> {
  const b = await backend();
  if (!(await b.setNx(`${P}room:${room.id}`, JSON.stringify(room)))) throw new RoomError("UNAVAILABLE", "Couldn't create the room. Try again.");
  await b.lpush(`${P}by:${addrKey(room.creator)}`, room.id);
}

export async function getRoomRecord(id: string): Promise<RoomRecord | null> {
  if (!/^room_[0-9a-f]{24}$/.test(id)) return null;
  return parse<RoomRecord>(await (await backend()).get(`${P}room:${id}`));
}

export async function getCancellation(id: string): Promise<{ at: number } | null> {
  return parse<{ at: number }>(await (await backend()).get(`${P}cancel:${id}`));
}

export async function setCancellation(id: string, at: number): Promise<boolean> {
  return (await backend()).setNx(`${P}cancel:${id}`, JSON.stringify({ at }));
}

export async function getParticipant(id: string, address: string): Promise<ParticipantRecord | null> {
  return parse<ParticipantRecord>(await (await backend()).get(`${P}p:${id}:${addrKey(address)}`));
}

export async function putParticipant(id: string, p: ParticipantRecord): Promise<void> {
  await (await backend()).set(`${P}p:${id}:${addrKey(p.address)}`, JSON.stringify(p));
}

/** Atomically join: one record per address, and never more than `target` slots. */
export async function addParticipant(id: string, address: string, target: number, now: number): Promise<ParticipantRecord> {
  const b = await backend();
  const key = `${P}p:${id}:${addrKey(address)}`;
  const draft: ParticipantRecord = { address: addrKey(address), slot: 0, joinedAt: now, payment: { planId: null, planCreatedAt: null, txHash: null, confirmedAt: null } };
  if (!(await b.setNx(key, JSON.stringify(draft)))) throw new RoomError("ALREADY_JOINED", "You've already joined this room.");
  const slot = await b.incr(`${P}count:${id}`);
  if (slot > target) {
    await b.del(key);
    throw new RoomError("FULL", "This room is full.");
  }
  const p = { ...draft, slot };
  await b.set(key, JSON.stringify(p));
  await b.set(`${P}slot:${id}:${slot}`, addrKey(address));
  await b.lpush(`${P}by:${addrKey(address)}`, id);
  return p;
}

/** Every participant, in slot order. */
export async function listParticipants(id: string, target: number): Promise<ParticipantRecord[]> {
  const b = await backend();
  const count = Math.min(Number((await b.get(`${P}count:${id}`)) ?? 0), target);
  const out: ParticipantRecord[] = [];
  for (let n = 1; n <= count; n++) {
    const a = await b.get(`${P}slot:${id}:${n}`);
    if (typeof a !== "string") continue;
    const p = parse<ParticipantRecord>(await b.get(`${P}p:${id}:${a}`));
    if (p) out.push(p);
  }
  return out;
}

export async function roomIdsFor(address: string, limit = 50): Promise<string[]> {
  const ids = await (await backend()).lrange(`${P}by:${addrKey(address)}`, 0, limit - 1);
  return [...new Set(ids)];
}

/** Count a transaction once, globally. True when this call counted it (or it
 *  was already counted for exactly this room and participant). */
export async function claimTx(hash: string, id: string, address: string): Promise<boolean> {
  const b = await backend();
  const owner = `${id}:${addrKey(address)}`;
  if (await b.setNx(`${P}tx:${hash.toLowerCase()}`, owner)) return true;
  return (await b.get(`${P}tx:${hash.toLowerCase()}`)) === owner;
}

/** A short exclusive section per participant (starting a payment). */
export async function withParticipantLock<T>(id: string, address: string, fn: () => Promise<T>): Promise<T> {
  const b = await backend();
  const key = `${P}lock:${id}:${addrKey(address)}`;
  if (!(await b.setNx(key, "1", 30))) throw new RoomError("BUSY", "Your payment is already being prepared — give it a moment.");
  try {
    return await fn();
  } finally {
    await b.del(key);
  }
}

export function __resetRoomsForTests(): void {
  mem.clear();
}
