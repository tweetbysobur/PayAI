/**
 * Verifies a Telegram webhook delivery actually came from Telegram.
 *
 * Telegram lets you set a `secret_token` when you call `setWebhook`; every
 * real delivery then carries it back as `X-Telegram-Bot-Api-Secret-Token`.
 * Without checking it, this route's public URL (unauthenticated by design —
 * Telegram can't attach a bearer token the way a first-party caller could)
 * would let anyone who finds it send fake "Update"s and, via the /buy or
 * /withdraw command handlers, trigger real signed transactions from a
 * Telegram user's wallet. Same posture and same constant-time-compare shape
 * as app/api/cron/run-schedules/route.ts's CRON_SECRET check — the other
 * endpoint in this app that trusts a bearer secret instead of a session.
 *
 * Server-only.
 */
import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * True only when TELEGRAM_WEBHOOK_SECRET is configured AND the request
 * carries the exact matching header. Fails closed: an unconfigured secret
 * means every request is rejected, never treated as "no check needed" —
 * mirrors run-schedules' `if (!secret || ...)` refusal rather than silently
 * running unauthenticated the way a live signer with no VERIPAYAI_API_KEY
 * would be caught by lib/platform/auth.ts.
 */
export function isVerifiedTelegramWebhook(req: NextRequest): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return false;
  const provided = req.headers.get("x-telegram-bot-api-secret-token");
  if (!provided) return false;
  return safeCompare(provided, secret);
}
