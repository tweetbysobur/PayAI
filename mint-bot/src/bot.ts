import { Telegraf, Markup } from "telegraf";
import { ethers } from "ethers";
import { getChain, txUrl, addressUrl } from "./chain.js";
import { getContract, isConfigured, updateContract, type MintArgs } from "./store.js";
import { custodialMint, noncustodialUri, prepareMint } from "./mint.js";

const adminIds = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function isAdmin(id?: number): boolean {
  return id !== undefined && adminIds.has(String(id));
}

// Accept the private key with or without the 0x prefix — wallet apps export
// it both ways — and normalize to the 0x form ethers expects.
const rawKey = (process.env.CUSTODIAL_PRIVATE_KEY || "").trim().replace(/^0x/i, "");
const custodialKey = rawKey ? `0x${rawKey}` : "";
const custodialEnabled = /^0x[a-fA-F0-9]{64}$/.test(custodialKey);

export function buildBot(): Telegraf {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const bot = new Telegraf(token);

  bot.start((ctx) =>
    ctx.reply(
      [
        `NFT mint bot on ${getChain().name}.`,
        "",
        "Commands:",
        "/mint - mint an NFT",
        "/status - show the configured contract",
        "/help - full command list",
      ].join("\n"),
    ),
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "/mint - mint the configured NFT",
        "/status - show contract, price, network",
        "",
        "Admin:",
        "/setcontract 0x... - set the NFT contract address",
        "/setfn <name> <none|quantity|to|to_quantity> - set the mint function",
        "/setprice <MON> - set price per mint",
      ].join("\n"),
    ),
  );

  bot.command("status", (ctx) => {
    const c = getContract();
    const chain = getChain();
    if (!isConfigured()) {
      return ctx.reply(
        `Network: ${chain.name}\nContract: not set yet.\nAn admin sets it with /setcontract 0x...`,
      );
    }
    return ctx.reply(
      [
        `Network: ${chain.name}`,
        `Contract: ${c.address}`,
        `Mint fn: ${c.mintFunction}(${c.mintArgs})`,
        `Price: ${c.price} ${chain.symbol}`,
        `Custodial mode: ${custodialEnabled ? "on" : "off"}`,
        addressUrl(c.address),
      ].join("\n"),
    );
  });

  // ---- admin config ----
  bot.command("setcontract", (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply("Not allowed.");
    const addr = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      return ctx.reply("Usage: /setcontract 0x<40 hex>");
    }
    updateContract({ address: ethers.getAddress(addr) });
    return ctx.reply(`Contract set: ${addr}\nMinting is live. Users can run /mint.`);
  });

  bot.command("setfn", (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply("Not allowed.");
    const [, name, args] = ctx.message.text.split(/\s+/);
    const valid: MintArgs[] = ["none", "quantity", "to", "to_quantity"];
    if (!name || !valid.includes(args as MintArgs)) {
      return ctx.reply("Usage: /setfn <name> <none|quantity|to|to_quantity>");
    }
    updateContract({ mintFunction: name, mintArgs: args as MintArgs });
    return ctx.reply(`Mint function set: ${name}(${args})`);
  });

  bot.command("setprice", (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply("Not allowed.");
    const price = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!price || isNaN(Number(price))) return ctx.reply("Usage: /setprice <MON>");
    updateContract({ price });
    return ctx.reply(`Price set: ${price} ${getChain().symbol}`);
  });

  // ---- mint ----
  bot.command("mint", (ctx) => {
    if (!isConfigured()) {
      return ctx.reply("No contract set yet. Ask an admin to run /setcontract.");
    }
    const rows = [Markup.button.callback("Mint with my wallet", "mint:nc")];
    if (custodialEnabled) rows.push(Markup.button.callback("Mint for me (bot pays)", "mint:cu"));
    return ctx.reply("Choose how to mint:", Markup.inlineKeyboard([rows]));
  });

  bot.action("mint:nc", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isConfigured()) return ctx.reply("No contract set yet.");
    const uri = noncustodialUri(1);
    return ctx.reply(
      [
        "Open this in your wallet to sign the mint yourself:",
        "",
        uri,
        "",
        "Your wallet pays gas and any mint price. The bot never holds your keys.",
      ].join("\n"),
    );
  });

  bot.action("mint:cu", async (ctx) => {
    await ctx.answerCbQuery();
    if (!custodialEnabled) return ctx.reply("Custodial mode is off.");
    if (!isConfigured()) return ctx.reply("No contract set yet.");
    const cfg = getContract();
    const needsAddress = cfg.mintArgs === "to" || cfg.mintArgs === "to_quantity";
    if (needsAddress) {
      return ctx.reply(
        "This contract mints to a given address. Send:\n/mintto 0x<your wallet>",
      );
    }
    await ctx.reply("Minting on-chain, one moment...");
    try {
      const hash = await custodialMint(custodialKey, ethers.ZeroAddress, 1);
      return ctx.reply(`Minted.\n${txUrl(hash)}`);
    } catch (e) {
      return ctx.reply(`Mint failed: ${(e as Error).message}`);
    }
  });

  bot.command("mintto", async (ctx) => {
    if (!custodialEnabled) return ctx.reply("Custodial mode is off.");
    if (!isConfigured()) return ctx.reply("No contract set yet.");
    const addr = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      return ctx.reply("Usage: /mintto 0x<your wallet>");
    }
    await ctx.reply("Minting on-chain, one moment...");
    try {
      const hash = await custodialMint(custodialKey, ethers.getAddress(addr), 1);
      return ctx.reply(`Minted to ${addr}.\n${txUrl(hash)}`);
    } catch (e) {
      return ctx.reply(`Mint failed: ${(e as Error).message}`);
    }
  });

  return bot;
}

// Referenced for tooling parity; keeps prepareMint exported at the bot layer.
export { prepareMint };
