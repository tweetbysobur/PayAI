import type { NextRequest } from "next/server";
import { rateLimited } from "@/lib/platform/ratelimit";
import { planAuthFrom } from "@/lib/plan/http";
import { readJson, roomErrorResponse, roomJson, ROOM_IP_LIMIT, ROOM_RATE_LIMITS, SIGN_IN } from "@/lib/rooms/http";

/**
 * GET  /api/rooms/{id}                — the room. Anyone with the link may read
 *                                        it (no addresses but the recipient's and
 *                                        the viewer's own); a grant adds "you".
 * POST /api/rooms/{id} { op: "join" }    — join (wallet grant required)
 * POST /api/rooms/{id} { op: "pay" }     — the plan that pays your share (created
 *                                        or reused; nothing is signed or sent here)
 * POST /api/rooms/{id} { op: "confirm" } — count your share from that plan's
 *                                        verified on-chain result
 * POST /api/rooms/{id} { op: "cancel" }  — creator only, while nothing is paid
 *
 * Escrow rooms (er_…), all against the escrow contract's live state:
 * POST { op: "contribute", amount? }  — the contribute PLAN (target rooms take an amount;
 *                                        fixed-share rooms always the share)
 * POST { op: "claim" | "refund" | "cancel" } — that action's PLAN, after an eligibility
 *                                        check against the contract
 * POST { op: "confirm", action }        — record the wallet's confirmed transaction for
 *                                        that action, from the escrow's own event
 *
 * No wallet, hash or plan id is ever read from the body.
 */
export const dynamic = "force-dynamic";

const OPS = ["join", "pay", "confirm", "cancel"] as const;
type Op = (typeof OPS)[number];
const ESCROW_OPS = ["contribute", "claim", "refund", "cancel", "confirm"] as const;
type EscrowOp = (typeof ESCROW_OPS)[number];
const ESCROW_ACTIONS = ["create", "contribute", "claim", "refund", "cancel"] as const;
const isEscrowId = (id: string) => /^er_[0-9a-f]{24}$/.test(id);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const ip = await rateLimited(req, "rooms-ip", ROOM_IP_LIMIT);
  if (ip) return ip;
  const { id } = await ctx.params;
  const auth = planAuthFrom(req);
  if (auth) {
    const limited = await rateLimited(req, "rooms-read", { ...ROOM_RATE_LIMITS.read, subject: auth.wallet });
    if (limited) return limited;
  }
  try {
    if (isEscrowId(id)) {
      const { getEscrowRoom } = await import("@/lib/rooms/escrowService");
      return roomJson({ ok: true, room: await getEscrowRoom(id, auth?.wallet ?? null) });
    }
    const { getRoom } = await import("@/lib/rooms/service");
    return roomJson({ ok: true, room: await getRoom(id, auth?.wallet ?? null) });
  } catch (e) {
    return roomErrorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const ip = await rateLimited(req, "rooms-ip", ROOM_IP_LIMIT);
  if (ip) return ip;
  const auth = planAuthFrom(req);
  if (!auth) return roomJson(SIGN_IN, 401);
  const body = await readJson(req);
  const { id: rid } = await ctx.params;
  if (isEscrowId(rid)) {
    const eop = body?.op as EscrowOp | undefined;
    if (!eop || !ESCROW_OPS.includes(eop)) return roomJson({ ok: false, code: "INVALID_INPUT", message: "Unknown room action." }, 400);
    const bucket = eop === "contribute" ? "pay" : eop === "confirm" ? "confirm" : eop === "cancel" ? "cancel" : "pay";
    const limited = await rateLimited(req, `rooms-${bucket}`, { ...ROOM_RATE_LIMITS[bucket], subject: auth.wallet });
    if (limited) return limited;
    try {
      const svc = await import("@/lib/rooms/escrowService");
      if (eop === "confirm") {
        const action = body?.action as (typeof ESCROW_ACTIONS)[number] | undefined;
        if (!action || !ESCROW_ACTIONS.includes(action)) return roomJson({ ok: false, code: "INVALID_INPUT", message: "Say which action to confirm." }, 400);
        return roomJson({ ok: true, room: await svc.confirmEscrowAction(rid, auth.wallet, action) });
      }
      return roomJson({ ok: true, ...(await svc.startEscrowAction(rid, auth.wallet, eop, eop === "contribute" ? body?.amount : undefined)) });
    } catch (e) {
      return roomErrorResponse(e);
    }
  }
  const op = body?.op as Op | undefined;
  if (!op || !OPS.includes(op)) return roomJson({ ok: false, code: "INVALID_INPUT", message: "Unknown room action." }, 400);
  const limited = await rateLimited(req, `rooms-${op}`, { ...ROOM_RATE_LIMITS[op], subject: auth.wallet });
  if (limited) return limited;
  const { id } = await ctx.params;
  try {
    const service = await import("@/lib/rooms/service");
    if (op === "join") return roomJson({ ok: true, room: await service.joinRoom(id, auth.wallet) });
    if (op === "pay") return roomJson({ ok: true, ...(await service.startContribution(id, auth.wallet)) });
    if (op === "confirm") return roomJson({ ok: true, room: await service.confirmContribution(id, auth.wallet) });
    return roomJson({ ok: true, room: await service.cancelRoom(id, auth.wallet) });
  } catch (e) {
    return roomErrorResponse(e);
  }
}
