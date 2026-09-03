/** Shared context every command handler receives — the webhook route parses
 *  the Telegram Update once and hands each handler only what it needs. */
export interface CommandContext {
  /** Telegram's numeric user id, as a string — the identity a wallet is
   *  keyed on (see lib/telegram/wallets.ts). Stable for a given person
   *  across every chat they use the bot from. */
  telegramUserId: string;
  /** Whitespace-split words after the command itself, e.g. "/buy 0xabc 1"
   *  -> ["0xabc", "1"]. */
  args: string[];
}
