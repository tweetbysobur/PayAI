import "server-only";
import { getTelegramWalletAccount } from "@/lib/telegram/wallets";
import { runTrade, type TradeRunResult } from "@/lib/telegram/tradeRunner";
import type { CommandContext } from "./types";

function formatResult(result: TradeRunResult): string {
  if (!result.ok) return `Trade failed: ${result.message}`;
  return [
    `Traded ${result.spend.amount} ${result.spend.token} → ${result.receive.amount} ${result.receive.token} via ${result.provider}.`,
    result.explorerUrl,
  ].join("\n");
}

/** /buy <token address> <MON amount> — spends MON to acquire the named
 *  token. MON is the only input asset phase 1 supports for /buy (see the
 *  plan's deferred list for a quote-asset argument); this mirrors the
 *  genre's own convention (spend the chain's native asset by default). */
export async function handleBuy(ctx: CommandContext): Promise<string> {
  const [token, amount] = ctx.args;
  if (!token || !amount) return "Usage: /buy <token address> <MON amount>";

  const account = await getTelegramWalletAccount(ctx.telegramUserId);
  if (!account) return "Run /start first to get a wallet.";

  const result = await runTrade(account, { action: "buy", inputToken: "MON", outputToken: token, amount, amountType: "exact_input" });
  return formatResult(result);
}

/** /sell <token address> <token amount> — sells the named token for MON. */
export async function handleSell(ctx: CommandContext): Promise<string> {
  const [token, amount] = ctx.args;
  if (!token || !amount) return "Usage: /sell <token address> <token amount>";

  const account = await getTelegramWalletAccount(ctx.telegramUserId);
  if (!account) return "Run /start first to get a wallet.";

  const result = await runTrade(account, { action: "sell", inputToken: token, outputToken: "MON", amount, amountType: "exact_input" });
  return formatResult(result);
}
