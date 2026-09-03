import "server-only";
import { getOrCreateTelegramWallet } from "@/lib/telegram/wallets";
import { getWalletBalance } from "@/lib/monad/balance";
import type { CommandContext } from "./types";

/** /balance — MON + USDC only in phase 1 (see the plan's explicitly
 *  deferred list for portfolio-wide multi-token balance). */
export async function handleBalance(ctx: CommandContext): Promise<string> {
  const wallet = await getOrCreateTelegramWallet(ctx.telegramUserId);
  try {
    const bal = await getWalletBalance(wallet.address as `0x${string}`);
    return `${wallet.address}\n\nMON: ${bal.mon}\nUSDC: ${bal.usdc}`;
  } catch {
    // getWalletBalance() throws on an RPC failure rather than fabricating a
    // 0 — never show 0 here, that would read as "your funds are gone".
    return "Couldn't reach Monad to check your balance right now. Try again in a moment.";
  }
}
