/**
 * PayAI Rooms — the HTTP boundary shared by app/api/rooms/**. Thin, like the
 * Plan API's (lib/plan/http.ts): identity is the wallet grant cookie only;
 * every rule is the service's; errors map to statuses with no internals.
 *
 * Server-only.
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { RoomError, type RoomErrorCode } from "./store";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** IP first (before identity is known), then per wallet, per operation. */
export const ROOM_IP_LIMIT = { max: 120, windowSec: 60 } as const;
export const ROOM_RATE_LIMITS = {
  read: { max: 60, windowSec: 60 },
  create: { max: 10, windowSec: 300 },
  join: { max: 20, windowSec: 300 },
  pay: { max: 20, windowSec: 300 },
  confirm: { max: 30, windowSec: 60 },
  cancel: { max: 10, windowSec: 300 },
} as const;

export const ROOM_ERROR_STATUS: Readonly<Record<RoomErrorCode, number>> = {
  INVALID_INPUT: 400,
  UNSUPPORTED_ASSET: 422,
  NOT_FOUND: 404,
  FULL: 409,
  ALREADY_JOINED: 409,
  NOT_JOINED: 409,
  CLOSED: 409,
  ALREADY_PAID: 409,
  IN_FLIGHT: 409,
  NOT_CREATOR: 403,
  NOT_CANCELLABLE: 409,
  RECIPIENT_CANNOT_JOIN: 409,
  PAYMENT_UNAVAILABLE: 503,
  NOT_SETTLED: 409,
  MISMATCH: 422,
  TX_ALREADY_COUNTED: 409,
  BUSY: 429,
  UNAVAILABLE: 503,
  ESCROW_UNAVAILABLE: 503,
  NOT_LIVE: 409,
  NOT_ELIGIBLE: 409,
};

export function roomJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function roomErrorResponse(e: unknown): NextResponse {
  if (e instanceof RoomError) return roomJson({ ok: false, code: e.code, message: e.message }, ROOM_ERROR_STATUS[e.code] ?? 500);
  // A plan-layer refusal while creating the share's plan (e.g. KV down).
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "UNAVAILABLE") return roomJson({ ok: false, code: "UNAVAILABLE", message: "Rooms are unavailable right now. Try again in a moment." }, 503);
  if (code === "NOT_FOUND" || code === "WALLET_MISMATCH") return roomJson({ ok: false, code: "NOT_SETTLED", message: "That payment can't be found any more. Start your payment again." }, 409);
  // Unexpected: log server-side (never sent to the client) so it can be fixed.
  console.error("[rooms] unexpected error", code ?? "", e instanceof Error ? e.message : e);
  return roomJson({ ok: false, code: "INTERNAL_ERROR", message: "Rooms are temporarily unavailable. Try again in a moment." }, 502);
}

export const SIGN_IN = { ok: false, code: "WALLET_REQUIRED", message: "Unlock your wallet to use Rooms." } as const;

export async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  const raw = await req.text().catch(() => "");
  if (raw.length > 4096) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
