/**
 * Browser client for the Rooms API (app/api/rooms/**). Same-origin, no-store,
 * and it never sends a wallet, amount, hash or plan id — the server takes
 * identity from the wallet grant and everything else from the room.
 */
import type { RoomSummary, RoomView } from "./service";

export type { RoomSummary, RoomView, RoomSlotView, RoomActivity } from "./service";

export interface RoomPreviewDTO {
  symbol: string;
  total: string;
  share: string;
  participants: number;
  recipient: { address: string; label: string | null; isCreator: boolean };
  expiresInDays: number;
  verified: false;
}

export type Reply<T> = { ok: true; data: T } | { ok: false; status: number; code: string | null; message: string };

async function call<T>(url: string, init: RequestInit | undefined, pick: (b: Record<string, unknown>) => T): Promise<Reply<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    return { ok: false, status: 0, code: null, message: "Couldn't reach PayAI. Check your connection." };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && body?.ok === true) return { ok: true, data: pick(body) };
  return {
    ok: false, status: res.status,
    code: typeof body?.code === "string" ? body.code : null,
    message: typeof body?.message === "string" ? body.message : res.status === 429 ? "Too many requests — try again in a minute." : "Something went wrong. Try again in a moment.",
  };
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const listRooms = () => call("/api/rooms", undefined, (b) => b.rooms as RoomSummary[]);
export const previewRoom = (text: string) => call("/api/rooms", post({ op: "preview", text }), (b) => b.preview as RoomPreviewDTO);
export const createRoom = (text: string, memo: string) => call("/api/rooms", post({ op: "create", text, memo }), (b) => b.room as RoomView);
export const getRoom = (id: string) => call(`/api/rooms/${encodeURIComponent(id)}`, undefined, (b) => b.room as RoomView);
export const joinRoom = (id: string) => call(`/api/rooms/${encodeURIComponent(id)}`, post({ op: "join" }), (b) => b.room as RoomView);
export const confirmShare = (id: string) => call(`/api/rooms/${encodeURIComponent(id)}`, post({ op: "confirm" }), (b) => b.room as RoomView);
export const cancelRoom = (id: string) => call(`/api/rooms/${encodeURIComponent(id)}`, post({ op: "cancel" }), (b) => b.room as RoomView);
export const payShare = (id: string) =>
  call(`/api/rooms/${encodeURIComponent(id)}`, post({ op: "pay" }), (b) => ({ planId: b.planId as string, plan: b.plan, review: b.review }));

/* ── Escrow rooms ──────────────────────────────────────────────────────── */

import type { EscrowRoomForm, EscrowRoomPreview, EscrowRoomView, EscrowSummary, FundsCheck, PublicRoomCard } from "./escrowService";
export type { EscrowRoomForm, EscrowRoomPreview, EscrowRoomView, EscrowSummary, FundsCheck, PublicRoomCard } from "./escrowService";

export type EscrowActionKind = "create" | "contribute" | "claim" | "refund" | "cancel";
export interface PlanStart { planId: string; plan: unknown; review: unknown; funds?: FundsCheck | null }

export const listAllRooms = () => call("/api/rooms", undefined, (b) => ({ rooms: (b.rooms ?? []) as RoomSummary[], escrowRooms: (b.escrowRooms ?? []) as EscrowSummary[] }));
export const previewEscrowRoom = (form: EscrowRoomForm) => call("/api/rooms", post({ op: "escrow-preview", form }), (b) => b.preview as EscrowRoomPreview);
export const createEscrowRoom = (form: EscrowRoomForm) =>
  call("/api/rooms", post({ op: "escrow-create", form }), (b) => ({ id: b.id as string, planId: b.planId as string, plan: b.plan, review: b.review }));
export const getEscrowRoom = (id: string) => call(`/api/rooms/${encodeURIComponent(id)}`, undefined, (b) => b.room as EscrowRoomView);
export const startEscrowAction = (id: string, op: Exclude<EscrowActionKind, "create">, amount?: string) =>
  call(`/api/rooms/${encodeURIComponent(id)}`, post(amount !== undefined ? { op, amount } : { op }), (b) => ({ planId: b.planId as string, plan: b.plan, review: b.review, funds: (b.funds ?? null) as FundsCheck | null }));
export const confirmEscrowAction = (id: string, action: EscrowActionKind) =>
  call(`/api/rooms/${encodeURIComponent(id)}`, post({ op: "confirm", action }), (b) => b.room as EscrowRoomView);
export const listLiveRooms = () =>
  call("/api/rooms/live", undefined, (b) => ({ available: b.available === true, reason: (b.reason ?? null) as string | null, rooms: (b.rooms ?? []) as PublicRoomCard[] }));
