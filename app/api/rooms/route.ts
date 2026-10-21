import type { NextRequest } from "next/server";
import { rateLimited } from "@/lib/platform/ratelimit";
import { roomsAllowed, ROOMS_HIDDEN } from "@/lib/rooms/access";
import { planAuthFrom } from "@/lib/plan/http";
import { readJson, roomErrorResponse, roomJson, ROOM_IP_LIMIT, ROOM_RATE_LIMITS, SIGN_IN } from "@/lib/rooms/http";

/**
 * GET  /api/rooms                                — the caller's rooms (created or joined)
 * POST /api/rooms { op: "preview", text }         — what a room request means, computed; nothing stored
 * POST /api/rooms { op: "create", text, memo? }   — create it (no transaction, no funds move)
 * POST /api/rooms { op: "escrow-preview", form }   — an escrow room's exact terms, fee and conditions (nothing stored)
 * POST /api/rooms { op: "escrow-create", form }    — store it and return the creator's create_room PLAN to review
 *                                                   and sign (nothing is signed or sent here)
 *
 * Identity is the wallet grant only. See lib/rooms/service.ts.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ip = await rateLimited(req, "rooms-ip", ROOM_IP_LIMIT);
  if (ip) return ip;
  const auth = planAuthFrom(req);
  if (!auth) return roomJson(SIGN_IN, 401);
  if (!roomsAllowed(auth.wallet)) return roomJson(ROOMS_HIDDEN, 404);
  const limited = await rateLimited(req, "rooms-read", { ...ROOM_RATE_LIMITS.read, subject: auth.wallet });
  if (limited) return limited;
  try {
    const { listMyRooms } = await import("@/lib/rooms/service");
    const { listMyEscrowRooms, escrowCreateAvailability } = await import("@/lib/rooms/escrowService");
    const [rooms, escrowRooms, escrowCreate] = await Promise.all([listMyRooms(auth.wallet), listMyEscrowRooms(auth.wallet), escrowCreateAvailability(auth.wallet)]);
    return roomJson({ ok: true, rooms, escrowRooms, escrowCreate });
  } catch (e) {
    return roomErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const ip = await rateLimited(req, "rooms-ip", ROOM_IP_LIMIT);
  if (ip) return ip;
  const auth = planAuthFrom(req);
  if (!auth) return roomJson(SIGN_IN, 401);
  if (!roomsAllowed(auth.wallet)) return roomJson(ROOMS_HIDDEN, 404);
  const body = await readJson(req);
  const op = body?.op;
  if (op === "escrow-preview" || op === "escrow-create") {
    const limited = await rateLimited(req, op === "escrow-create" ? "rooms-create" : "rooms-read", { ...(op === "escrow-create" ? ROOM_RATE_LIMITS.create : ROOM_RATE_LIMITS.read), subject: auth.wallet });
    if (limited) return limited;
    try {
      const svc = await import("@/lib/rooms/escrowService");
      if (op === "escrow-preview") return roomJson({ ok: true, preview: await svc.previewEscrowRoom(auth.wallet, body?.form) });
      return roomJson({ ok: true, ...(await svc.createEscrowRoom(auth.wallet, body?.form)) });
    } catch (e) {
      return roomErrorResponse(e);
    }
  }
  if (!body || (op !== "preview" && op !== "create") || typeof body.text !== "string") {
    return roomJson({ ok: false, code: "INVALID_INPUT", message: "Describe the room to create." }, 400);
  }
  const limited = await rateLimited(req, op === "create" ? "rooms-create" : "rooms-read", { ...(op === "create" ? ROOM_RATE_LIMITS.create : ROOM_RATE_LIMITS.read), subject: auth.wallet });
  if (limited) return limited;
  try {
    const service = await import("@/lib/rooms/service");
    if (op === "preview") {
      const p = await service.previewRoom(auth.wallet, body.text);
      return roomJson({
        ok: true,
        preview: {
          symbol: p.asset.symbol, total: p.total, share: p.share, participants: p.participants,
          recipient: p.recipient, expiresInDays: p.expiresInDays, verified: false,
        },
      });
    }
    return roomJson({ ok: true, room: await service.createRoom(auth.wallet, body.text, body.memo) });
  } catch (e) {
    return roomErrorResponse(e);
  }
}
