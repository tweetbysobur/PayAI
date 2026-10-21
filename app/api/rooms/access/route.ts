import type { NextRequest } from "next/server";
import { planAuthFrom } from "@/lib/plan/http";
import { roomsAllowed } from "@/lib/rooms/access";
import { roomJson, ROOM_IP_LIMIT } from "@/lib/rooms/http";
import { rateLimited } from "@/lib/platform/ratelimit";

/** GET /api/rooms/access — whether this viewer can use Rooms (lib/rooms/access.ts). */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ip = await rateLimited(req, "rooms-ip", ROOM_IP_LIMIT);
  if (ip) return ip;
  return roomJson({ ok: true, allowed: roomsAllowed(planAuthFrom(req)?.wallet ?? null) });
}
