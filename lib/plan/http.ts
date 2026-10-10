/**
 * The Plan API's HTTP boundary (Phase 2C, Stage 3C) — shared by
 * app/api/plans/route.ts and app/api/plans/[planId]/route.ts.
 *
 * Deliberately thin. Per request the route:
 *   1. applies the IP rate limit itself (rateLimited with PLAN_IP_LIMIT —
 *      every route calls the limiter directly, see
 *      test/api-rate-limit-coverage.test.ts);
 *   2. authenticates the wallet grant cookie (lib/auth/walletGrant.ts) —
 *      the ONLY source of identity: no wallet is read from a body or query,
 *      and a merchant API key grants nothing here (plans are wallet-owned);
 *   3. applies the per-wallet rate limit for the operation;
 *   4. parses and minimally shape-checks the JSON body;
 *   5. calls the Plan Service with { wallet: grant.address } — never the
 *      request, cookies or headers;
 *   6. maps a PlanError to its HTTP status; anything else is a generic 502.
 *
 * Every plan rule (ownership, approval, expiry, abandonment, current step,
 * quote attempts and freshness, build records, settlement) stays in the
 * service. Every response carries Cache-Control: no-store — a quote response
 * carries the one-time raw quote token.
 *
 * Server-only.
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { decodeWalletGrant, WALLET_GRANT_COOKIE } from "@/lib/auth/walletGrant";
import { rateLimited } from "@/lib/platform/ratelimit";
import { PlanError, type PlanErrorCode } from "./errors";
import type { PlanAuth } from "./service";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Per-wallet limits (requests per window), by operation. */
export const PLAN_RATE_LIMITS = {
  create: { max: 10, windowSec: 300 },
  quote: { max: 20, windowSec: 60 },
  bind: { max: 30, windowSec: 60 },
  tx: { max: 30, windowSec: 60 },
  settle: { max: 60, windowSec: 60 },
  read: { max: 60, windowSec: 60 }, // list / get / next
  manage: { max: 60, windowSec: 60 }, // approve / abandon
} as const;
export type PlanRateOp = keyof typeof PLAN_RATE_LIMITS;

/** The IP-level limit applied before anything else: above every per-wallet
 *  budget so it never undercuts them, but bounded for unauthenticated noise. */
export const PLAN_IP_LIMIT = { max: 120, windowSec: 60 } as const;

/** Sized for a long plan's draft (≈500 bytes per action; the Intent IR
 *  allows MAX_INTENT_NODES actions) and aligned with the store's
 *  serialized-plan cap — a resource bound, read only after the IP and wallet
 *  rate limits. */
const MAX_BODY_BYTES = 512 * 1024;

/** The approved PlanErrorCode → HTTP status mapping (every code listed). */
export const PLAN_ERROR_STATUS: Readonly<Record<PlanErrorCode, number>> = {
  // Malformed / invalid input.
  UNVALIDATED_GRAPH: 400,
  INVALID_PLAN: 400,
  INVALID_NODE: 400,
  RECIPIENT_UNRESOLVED: 400,
  // Ownership: another wallet's plan reads exactly like a missing one.
  NOT_FOUND: 404,
  WALLET_MISMATCH: 404,
  // The plan's state doesn't allow it (now).
  CONFLICT: 409,
  NOT_APPROVABLE: 409,
  NOT_APPROVED: 409,
  STEP_NOT_READY: 409,
  SIGNATURE_UNRESOLVED: 409,
  // The step's bound inputs can't be resolved from what was confirmed.
  OUTPUT_NOT_CONFIRMED: 409,
  UNKNOWN_OUTPUT: 409,
  OUTPUT_NOT_VERIFIED: 409,
  INVALID_CONFIRMED_VALUE: 409,
  TOKEN_MISMATCH: 409,
  NATIVE_OUTPUT_NOT_BINDABLE: 409,
  INVALID_REMAINDER: 409,
  REMAINDER_UNDERFLOW: 409,
  REMAINDER_OVERFLOW: 409,
  FEE_TERMS_UNAVAILABLE: 409,
  EXPIRED: 410,
  QUOTE_REFUSED: 422,
  SETTLEMENT_PENDING: 202,
  // Internal inconsistency — never detailed to the client.
  CORRUPT: 500,
  GRAPH_MUTATION: 500,
  UNAVAILABLE: 503,
};

const GENERIC: Partial<Record<PlanErrorCode, string>> = {
  CORRUPT: "This plan can't be loaded. Start a new plan.",
  GRAPH_MUTATION: "This plan can't be loaded. Start a new plan.",
  UNAVAILABLE: "Plans are unavailable right now. Try again in a moment.",
};

export function planJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Mark any response (e.g. the limiter's 429) as never cacheable. */
export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** A request the route itself refuses before reaching the service. */
export class PlanInputError extends Error {}

/** PlanError → its mapped status; anything else → a generic 502. Internal
 *  details are never returned. */
export function planErrorResponse(e: unknown): NextResponse {
  if (e instanceof PlanInputError) return planJson({ ok: false, code: "INVALID_INPUT", message: e.message }, 400);
  if (e instanceof PlanError) {
    const status = PLAN_ERROR_STATUS[e.code] ?? 500;
    return planJson({ ok: false, code: e.code, message: GENERIC[e.code] ?? e.message }, status);
  }
  return planJson({ ok: false, code: "INTERNAL_ERROR", message: "Plans are temporarily unavailable. Try again in a moment." }, 502);
}

/** The authenticated wallet from the grant cookie, or null. */
export function planAuthFrom(req: NextRequest): PlanAuth | null {
  const grant = decodeWalletGrant(req.cookies.get(WALLET_GRANT_COOKIE)?.value);
  return grant ? { wallet: grant.address } : null;
}

export function grantRequired(): NextResponse {
  return planJson({ ok: false, code: "wallet_grant_required", message: "Unlock your wallet to manage your plans." }, 401);
}

/** The grant (after the route's IP limit). Returns the auth, or the 401. */
export function authenticate(req: NextRequest): PlanAuth | NextResponse {
  return planAuthFrom(req) ?? grantRequired();
}

/** The per-wallet limit for one operation; null when within it. */
export async function walletLimited(req: NextRequest, auth: PlanAuth, op: PlanRateOp): Promise<NextResponse | null> {
  const limited = await rateLimited(req, `plans-${op}`, { ...PLAN_RATE_LIMITS[op], subject: auth.wallet });
  return limited ? noStore(limited) : null;
}

/** The JSON body as a plain object (bounded size), or PlanInputError. */
export async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new PlanInputError("Invalid request body.");
  }
  if (text.length > MAX_BODY_BYTES) throw new PlanInputError("Request body is too large.");
  let body: unknown;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new PlanInputError("Invalid JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new PlanInputError("Expected a JSON object.");
  return body as Record<string, unknown>;
}

/** A required string field of bounded length (the service validates its
 *  format and meaning). */
export function stringField(body: Record<string, unknown>, name: string, max: number): string {
  const v = body[name];
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new PlanInputError(`"${name}" is required.`);
  return v;
}
