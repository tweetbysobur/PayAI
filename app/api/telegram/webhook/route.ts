import { NextRequest, NextResponse } from "next/server";
import { isVerifiedTelegramWebhook } from "@/lib/telegram/webhookAuth";

/**
 * POST /api/telegram/webhook — Telegram delivers every bot update here.
 *
 * This route is the whole reason lib/telegram/webhookAuth.ts exists: with
 * no secret check, its public URL alone would let anyone fabricate an
 * Update and trigger a real signed trade or withdrawal from a Telegram
 * user's custodial wallet. Order of operations matters — auth, THEN parse,
 * THEN de-dupe on Telegram's own update_id (a retried delivery of the same
 * update must never execute a /buy or /withdraw a second time), THEN
 * rate-limit per Telegram user, THEN dispatch. See the design doc this
 * feature was planned against for why each of those exists.
 *
 * Always answers 200 once authenticated, regardless of what happened
 * inside — the actual result reaches the user via a Telegram sendMessage
 * call, not the webhook response body. A non-2xx here makes Telegram
 * retry the whole update, which is exactly the double-execution risk the
 * update_id claim below exists to prevent; better to swallow an internal
 * error into a message to the user than invite a retry storm.
 *
 * A route with real settlement latency (multi-step trades, each a real
 * broadcast + confirmation wait) needs more than the platform default —
 * matches app/api/portfolio/discover/route.ts's own precedent for the same
 * reason.
 */
export const maxDuration = 30;

interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    chat: { id: number };
    text?: string;
  };
}

export async function POST(req: NextRequest) {
  if (!isVerifiedTelegramWebhook(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true }); // malformed body -- nothing meaningful to retry
  }

  const text = update.message?.text;
  const fromId = update.message?.from?.id;
  const chatId = update.message?.chat?.id;
  // Not a text message from an identifiable user (a sticker, an edited
  // message, a callback query, a channel post, ...) -- phase 1 only
  // understands text commands, so there is nothing to do.
  if (!text || fromId == null || chatId == null) {
    return NextResponse.json({ ok: true });
  }

  const { claimRequest, completeRequest, releaseRequest } = await import("@/lib/platform/idempotency");
  const dedupeKey = `telegram-update:${update.update_id}`;
  const claim = await claimRequest<{ handled: true }>(dedupeKey);
  if (!claim.claimed) {
    // Telegram already delivered this exact update_id before (a retry
    // after a slow response, or a genuine redelivery) -- already handled or
    // currently being handled either way, so do nothing a second time.
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = String(fromId);
  const { sendTelegramMessage } = await import("@/lib/telegram/send");

  const { rateLimited } = await import("@/lib/platform/ratelimit");
  // Keyed on the Telegram user id, not IP -- every delivery arrives from
  // Telegram's own servers, so IP-keying would lump every user's trading
  // activity into one shared budget (see lib/platform/ratelimit.ts's own
  // `subject` override doc).
  const limited = await rateLimited(req, "telegram", { subject: telegramUserId, max: 10, windowSec: 60 });
  if (limited) {
    await completeRequest(dedupeKey, { handled: true });
    await sendTelegramMessage(chatId, "You're sending commands too fast — try again in a moment.").catch(() => {});
    return NextResponse.json({ ok: true });
  }

  try {
    const { parseCommand, dispatchCommand } = await import("@/lib/telegram/commands");
    const { command, args } = parseCommand(text);
    const reply = await dispatchCommand(command, { telegramUserId, args });
    if (reply) await sendTelegramMessage(chatId, reply);
    await completeRequest(dedupeKey, { handled: true });
  } catch (e) {
    // A genuine unexpected throw -- every handled outcome (a failed trade,
    // an unknown command) returns a string rather than throwing, so this is
    // a real bug, not user error. Release rather than complete the claim so
    // a real Telegram retry can try again instead of being permanently
    // wedged at "in_progress".
    await releaseRequest(dedupeKey);
    console.error("[telegram webhook] unhandled error:", e);
    await sendTelegramMessage(chatId, "Something went wrong handling that. Please try again.").catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
