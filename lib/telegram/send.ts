/**
 * Sends a message back to a Telegram chat. Plain `fetch` against Telegram's
 * Bot API — no SDK dependency, matching lib/monad/dexscreener.ts's existing
 * precedent of a direct fetch over adding an npm package for one external
 * call this app makes in exactly one place.
 *
 * Server-only.
 */
import "server-only";

/** Throws on a missing/invalid token rather than silently no-op'ing — an
 *  unconfigured bot is a real misconfiguration that should surface loudly
 *  in logs, unlike the app's other "best-effort notification" callers
 *  (e.g. notifySwap in app/api/swap/confirm/route.ts) where the underlying
 *  action already succeeded and a failed notice must never mask that. Here,
 *  the message often IS the entire user-visible outcome of a command. */
export async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    // disable_web_page_preview: a /price or /buy reply often contains a
    // 0x address or explorer URL — Telegram would otherwise try to expand
    // it into a link preview card, which is just noise here.
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed (${res.status}): ${detail.slice(0, 500)}`);
  }
}
