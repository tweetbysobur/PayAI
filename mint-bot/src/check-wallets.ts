import "dotenv/config";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { getChain, getProvider } from "./chain.js";

/**
 * Prints the address and MON balance of every wallet in wallets.txt, so you can
 * confirm they are all funded before the drop.
 *
 * Run:  node dist/check-wallets.js
 */
async function main() {
  const file = resolve(process.cwd(), "wallets.txt");
  if (!existsSync(file)) throw new Error("No wallets.txt found.");
  const keys = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => `0x${l.replace(/^0x/i, "")}`)
    .filter((k) => /^0x[a-fA-F0-9]{64}$/.test(k));

  const provider = getProvider();
  const chain = getChain();
  console.log(`${keys.length} wallets on ${chain.name}:\n`);
  let total = 0n;
  for (let i = 0; i < keys.length; i++) {
    const w = new ethers.Wallet(keys[i], provider);
    try {
      const b = await provider.getBalance(w.address);
      total += b;
      console.log(`${i + 1}. ${w.address}  ${ethers.formatEther(b)} ${chain.symbol}`);
    } catch (e) {
      console.log(`${i + 1}. ${w.address}  error: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  console.log(`\nTotal: ${ethers.formatEther(total)} ${chain.symbol}`);
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
