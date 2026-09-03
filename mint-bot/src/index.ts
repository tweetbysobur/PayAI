import "dotenv/config";
import { buildBot } from "./bot.js";
import { getChain } from "./chain.js";
import { getContract, isConfigured } from "./store.js";

const bot = buildBot();

const chain = getChain();
console.log(`Monad NFT mint bot starting on ${chain.name} (chainId ${chain.chainId}).`);
console.log(
  isConfigured()
    ? `Contract configured: ${getContract().address}`
    : "No contract set yet. Use /setcontract in Telegram when the NFT is live.",
);

bot.launch(() => console.log("Bot is running. Talk to it in Telegram."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
