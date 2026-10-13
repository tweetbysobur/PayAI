import { roomsRemoved } from "@/lib/rooms/removed";

/** Rooms were removed from PayAI — see lib/rooms/removed.ts. */
export const dynamic = "force-dynamic";

export async function GET() {
  return roomsRemoved();
}
