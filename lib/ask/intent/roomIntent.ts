/**
 * Rooms through Ask PayAI — deterministic detection only (no model).
 *
 * What Ask can do with a room is exactly what the Rooms API supports
 * (lib/rooms/service.ts), each behind an explicit button on the room card in
 * the chat (components/ask/RoomAskCard.tsx):
 *
 *   create      "create a room for 100 USDC for 5 people (to bob.nad)"
 *               → the server's own preview, then "Create room" (no funds move)
 *   list        "show my rooms"
 *   status      "how is my room doing?" / "status of room_…"
 *   join        "join room_…"            → "Join room" (no funds move)
 *   contribute  "pay my share in room_…" → the share's PLAN, reviewed and
 *               approved in the existing plan card before any signature
 *
 * Escrow rooms (er_… ids or /r/er_… links) go through the SAME escrow Rooms
 * API as the room page (lib/rooms/escrowService.ts): status and progress from
 * the escrow contract, and a contribution only for an amount the person types
 * into the card (a fixed-share room's share comes from the contract's terms).
 *
 * Nothing here reads, invents or guesses a room: a room id is taken only
 * when the user wrote one (a room_… id or a room link). Without one, the card
 * shows the user's REAL rooms to choose from — or asks for the link, for a
 * room they haven't joined. Amounts, shares and recipients always come from
 * the server, never from this text.
 *
 * Pure: no I/O.
 */
import type { Understanding } from "./types";

export type RoomAction = "create" | "list" | "status" | "join" | "contribute";

/** A direct room (room_…) or an escrow room (er_…), as written or inside a
 *  shared link (/r/er_…, /dashboard/rooms/…). */
const ROOM_ID_RE = /\b((?:room|er)_[0-9a-f]{24})\b/i;
const ROOM_WORD_RE = /\brooms?\b/i;

const CREATE_RE = /\b(create|make|start|open|set\s*up|new)\b[^.?!]*\broom\b|^\s*(?:a\s+)?room\s+for\b/i;
const LIST_RE = /\b(my|all|show|list|see|view)\b[^.?!]*\brooms\b|\bwhat\s+rooms\b|\brooms\s+(?:i(?:'m|\s+am)\s+in|i\s+(?:created|joined|have))\b/i;
const JOIN_RE = /\bjoin\b/i;
const CONTRIBUTE_RE = /\b(pay|contribute|send|chip\s+in)\b[^.?!]*\b(share|contribution|part)\b|\b(pay|contribute|chip\s+in)\b[^.?!]*\b(?:room\b|(?:room|er)_[0-9a-f]{24}\b)/i;
const STATUS_RE = /\b(status|progress|how\s+(?:is|'s|are)|who\s+(?:has\s+)?paid|paid\s+yet|update\s+on|check)\b/i;

/** The room action a message asks for, or null when it isn't about rooms. */
export function detectRoomAction(text: string): { action: RoomAction; roomId: string | null } | null {
  if (typeof text !== "string") return null;
  if (!ROOM_WORD_RE.test(text) && !ROOM_ID_RE.test(text) && !/\bmy\s+share\b/i.test(text)) return null;
  const roomId = text.match(ROOM_ID_RE)?.[1]?.toLowerCase() ?? null;
  if (CREATE_RE.test(text) && !JOIN_RE.test(text)) return { action: "create", roomId: null };
  if (JOIN_RE.test(text)) return { action: "join", roomId };
  if (CONTRIBUTE_RE.test(text)) return { action: "contribute", roomId };
  if (LIST_RE.test(text) && !roomId) return { action: "list", roomId: null };
  if (STATUS_RE.test(text) || roomId) return { action: "status", roomId };
  if (/\brooms?\b/i.test(text) && /^\s*(?:show|list|my)\b/i.test(text)) return { action: "list", roomId: null };
  return null;
}

const LEAD: Record<RoomAction, string> = {
  create: "Here's the room as PayAI reads it. Nothing is created until you confirm, and creating it moves no funds.",
  list: "Your rooms:",
  status: "Here's the room:",
  join: "Here's the room. Joining moves no funds.",
  contribute: "Here's your share. You'll review it — amount, recipient and PayAI's fee — before anything is signed.",
};

/** The Understanding for a room request, or null. Always complete: what is
 *  still missing (which room) is asked by the card, from real data. */
export function detectRoomRequest(text: string): Understanding | null {
  const r = detectRoomAction(text);
  if (!r) return null;
  return {
    kind: "room", outcome: "complete",
    slots: { roomAction: r.action, roomId: r.roomId, roomText: r.action === "create" ? text.trim().slice(0, 300) : null },
  };
}

export const roomLead = (a: RoomAction) => LEAD[a];
