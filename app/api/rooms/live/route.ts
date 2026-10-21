import type { NextRequest } from "next/server";
import { rateLimited } from "@/lib/platform/ratelimit";
import { roomsOpenToAll } from "@/lib/rooms/access";
import { roomErrorResponse, roomJson, ROOM_IP_LIMIT } from "@/lib/rooms/http";

/**
 * GET /api/rooms/live — Live Rooms: escrow rooms whose creators opted in to
 * public discovery, with progress read from the escrow contract. Public, no
 * wallet needed; no contributor addresses. Also reports whether escrow Rooms
 * are available at all, so the page can say so plainly.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ip = await rateLimited(req, "rooms-ip", ROOM_IP_LIMIT);
  if (ip) return ip;
  try {
    if (!roomsOpenToAll()) return roomJson({ ok: true, available: false, reason: "Rooms aren't available yet.", rooms: [] });
    const svc = await import("@/lib/rooms/escrowService");
    const availability = await svc.escrowAvailability();
    if (!availability.available) return roomJson({ ok: true, available: false, reason: availability.reason, rooms: [] });
    return roomJson({ ok: true, available: true, reason: null, rooms: await svc.listPublicRooms() });
  } catch (e) {
    return roomErrorResponse(e);
  }
}
