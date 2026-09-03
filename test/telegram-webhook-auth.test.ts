import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

/**
 * The Telegram webhook route is unauthenticated in the ordinary sense (no
 * session, no bearer token Telegram could attach the way a first-party
 * caller would) -- isVerifiedTelegramWebhook's secret-header check is the
 * ONLY thing standing between the public webhook URL and anyone being able
 * to fabricate an "Update" that triggers a real signed trade or withdrawal.
 * Every failure mode here has to reject, never quietly pass.
 */

const SECRET = "a-real-webhook-secret";

function req(headers: Record<string, string> = {}) {
  return new NextRequest("https://usepayai.xyz/api/telegram/webhook", { method: "POST", headers });
}

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

describe("isVerifiedTelegramWebhook", () => {
  it("rejects when TELEGRAM_WEBHOOK_SECRET is not configured at all -- fails closed, not open", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { isVerifiedTelegramWebhook } = await import("@/lib/telegram/webhookAuth");
    expect(isVerifiedTelegramWebhook(req({ "x-telegram-bot-api-secret-token": SECRET }))).toBe(false);
  });

  it("rejects a request with no secret header", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const { isVerifiedTelegramWebhook } = await import("@/lib/telegram/webhookAuth");
    expect(isVerifiedTelegramWebhook(req())).toBe(false);
  });

  it("rejects a request with the wrong secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const { isVerifiedTelegramWebhook } = await import("@/lib/telegram/webhookAuth");
    expect(isVerifiedTelegramWebhook(req({ "x-telegram-bot-api-secret-token": "wrong-guess" }))).toBe(false);
  });

  it("rejects a secret that's a different LENGTH than the real one (would crash a naive timingSafeEqual call)", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const { isVerifiedTelegramWebhook } = await import("@/lib/telegram/webhookAuth");
    expect(isVerifiedTelegramWebhook(req({ "x-telegram-bot-api-secret-token": "short" }))).toBe(false);
  });

  it("accepts a request carrying the exact correct secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const { isVerifiedTelegramWebhook } = await import("@/lib/telegram/webhookAuth");
    expect(isVerifiedTelegramWebhook(req({ "x-telegram-bot-api-secret-token": SECRET }))).toBe(true);
  });
});
