import "dotenv/config";
import dns from "node:dns";
// Force IPv4 DNS resolution first to avoid EAI_AGAIN name-lookup failures on
// some Windows/IPv6 setups.
dns.setDefaultResultOrder("ipv4first");
import { buildBot } from "./bot.js";
import { getChain } from "./chain.js";
import { getContract, isConfigured } from "./store.js";

process.on("unhandledRejection", (err) => {
  console.error("Unhandled error:", err);
});

async function main() {
  const chain = getChain();
  console.log(`Monad NFT mint bot starting on ${chain.name} (chainId ${chain.chainId}).`);
  console.log(
    isConfigured()
      ? `Contract configured: ${getContract().address}`
      : "No contract set yet. Use /setcontract in Telegram when the NFT is live.",
  );

  const bot = buildBot();

  // Verify the token up front so a bad TELEGRAM_BOT_TOKEN gives a clear
  // message in the logs instead of an opaque crash loop.
  try {
    const me = await bot.telegram.getMe();
    console.log(`Token OK. Connected as @${me.username}.`);
  } catch (err) {
    console.error(
      "Could not connect to Telegram. Check TELEGRAM_BOT_TOKEN is correct, " +
        "with no extra spaces or missing characters.",
    );
    console.error(String(err));
    process.exit(1);
  }

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  await bot.launch();
  console.log("Bot is running. Talk to it in Telegram.");
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
