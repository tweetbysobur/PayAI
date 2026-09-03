import "server-only";
import { getOrCreateTelegramWallet } from "@/lib/telegram/wallets";
import type { CommandContext } from "./types";

export const HELP_TEXT = [
  "/balance — check your MON and USDC balance",
  "/price <token address> — look up a token",
  "/buy <token address> <MON amount> — spend MON to buy a token",
  "/sell <token address> <token amount> — sell a token for MON",
  "/withdraw <amount> <MON|token address> <to address> — send funds out",
].join("\n");

/** /start — get-or-create the user's wallet and show it, with an explicit,
 *  honest custody disclosure. This is the ONLY place that disclosure has
 *  to land, since getOrCreateTelegramWallet() is idempotent — a returning
 *  user sees the same address and the same reminder every time, not a
 *  one-time notice they could have missed. */
export async function handleStart(ctx: CommandContext): Promise<string> {
  const wallet = await getOrCreateTelegramWallet(ctx.telegramUserId);
  return [
    "Welcome to the PayAI trading bot for Monad.",
    "",
    `Your wallet: ${wallet.address}`,
    "",
    "This is a hot wallet — PayAI generates and holds this key so trades can execute directly from chat. Don't send this address more than you're comfortable trusting to a bot. You can withdraw everything at any time with /withdraw.",
    "",
    "You'll need some MON in this wallet before your first trade (every trade needs MON for gas, even one that doesn't spend MON directly).",
    "",
    "Commands:",
    HELP_TEXT,
  ].join("\n");
}
