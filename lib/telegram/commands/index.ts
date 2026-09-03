import "server-only";
import { handleStart, HELP_TEXT } from "./start";
import { handleBalance } from "./balance";
import { handlePrice } from "./price";
import { handleBuy, handleSell } from "./trade";
import { handleWithdraw } from "./withdraw";
import type { CommandContext } from "./types";

export type { CommandContext } from "./types";

/** Splits "/buy 0xabc 1.5" into { command: "/buy", args: ["0xabc", "1.5"] }.
 *  Telegram command text can carry a "@BotUsername" suffix (only relevant
 *  in group chats, but harmless to strip unconditionally) and a stray
 *  leading/trailing space. */
export function parseCommand(text: string): { command: string; args: string[] } {
  const trimmed = text.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head.split("@")[0].toLowerCase();
  return { command, args: rest };
}

/** Routes a parsed command to its handler and returns the reply text, or
 *  null for text that isn't a recognized command (silently ignored —
 *  Telegram delivers every message in a chat, not just commands, and this
 *  bot has no conversational fallback in phase 1). */
export async function dispatchCommand(command: string, ctx: CommandContext): Promise<string | null> {
  switch (command) {
    case "/start":
      return handleStart(ctx);
    case "/help":
      return HELP_TEXT;
    case "/balance":
      return handleBalance(ctx);
    case "/price":
      return handlePrice(ctx);
    case "/buy":
      return handleBuy(ctx);
    case "/sell":
      return handleSell(ctx);
    case "/withdraw":
      return handleWithdraw(ctx);
    default:
      return null;
  }
}
