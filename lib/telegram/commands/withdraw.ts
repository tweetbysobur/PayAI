import "server-only";
import { getTelegramWalletAccount } from "@/lib/telegram/wallets";
import { executeWithdraw } from "@/lib/telegram/executeTransfer";
import type { CommandContext } from "./types";

/** /withdraw <amount> <MON|token address> <to address> — sends funds out of
 *  the user's own custodial wallet. Real, irreversible fund movement, so
 *  the token has to be named by contract address (or the literal "MON") —
 *  never a bare symbol, same rule executeWithdraw itself enforces. */
export async function handleWithdraw(ctx: CommandContext): Promise<string> {
  const [amount, token, to] = ctx.args;
  if (!amount || !token || !to) return "Usage: /withdraw <amount> <MON|token address> <to address>";

  const account = await getTelegramWalletAccount(ctx.telegramUserId);
  if (!account) return "Run /start first to get a wallet.";

  const result = await executeWithdraw(account, token, amount, to);
  if (!result.ok) return `Withdrawal failed: ${result.message}`;
  return [`Sent ${result.amount} ${result.symbol} to ${to}.`, result.explorerUrl].join("\n");
}
