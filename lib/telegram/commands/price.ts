import "server-only";
import { inspectAddress } from "@/lib/monad/tokenIntelligence";
import type { CommandContext } from "./types";

/** /price <token address> — reuses lib/monad/tokenIntelligence.ts's
 *  inspectAddress() directly. No new logic: this is the exact module
 *  hardened elsewhere in this codebase against cache-poisoning and
 *  unbounded reads, and it never throws (see its own doc) — always a typed
 *  outcome, so this handler never needs its own try/catch. */
export async function handlePrice(ctx: CommandContext): Promise<string> {
  const address = ctx.args[0];
  if (!address) return "Usage: /price <token address>";

  const result = await inspectAddress(address);
  if (result.kind === "invalid") return `Couldn't look that up: ${result.reason}`;
  if (result.kind === "wallet") return "That's a wallet address, not a token contract.";
  if (result.kind === "unknown_contract") return "That contract doesn't behave like a token I can read.";

  const d = result.data;
  const liquidity = d.market.liquidity
    ? `${d.market.liquidity.label}: ${d.market.liquidity.usd ? `$${d.market.liquidity.usd}` : `${d.market.liquidity.mon} MON`}`
    : "Liquidity: unavailable";
  return [
    `${d.name} (${d.symbol})`,
    d.market.price ? `Price: $${d.market.price}` : "Price: unavailable",
    d.market.marketCapUsd ? `Market cap: $${d.market.marketCapUsd}` : "Market cap: unavailable",
    liquidity,
    d.isTradable ? "Tradable: yes" : "Tradable: no route found",
    d.address,
  ].join("\n");
}
