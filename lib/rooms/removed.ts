import { NextResponse } from "next/server";

/**
 * Rooms were removed from PayAI (Oct 2026). The Rooms API answers every
 * request with 410 Gone, so nothing can create, join, pay into or list a
 * room. The rest of lib/rooms is kept, unused, so the feature could be
 * restored deliberately — not reached by accident.
 */
export function roomsRemoved(): NextResponse {
  return NextResponse.json(
    { ok: false, code: "ROOMS_REMOVED", message: "Rooms aren't part of PayAI anymore." },
    { status: 410 },
  );
}
