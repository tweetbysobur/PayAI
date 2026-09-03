import { writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";

/**
 * Generates fresh wallets for multi-wallet minting.
 *
 * Usage:  node dist/gen-wallets.js 5     (creates 5 wallets)
 *
 * Writes the private keys to wallets.txt (one per line, appended if it exists)
 * and prints the public addresses to fund. wallets.txt is gitignored and stays
 * only on your computer. Keep it safe: anyone with these keys controls the
 * wallets and anything in them.
 */
const n = Number(process.argv[2] || "5");
if (!Number.isInteger(n) || n < 1 || n > 100) {
  console.error("Usage: node dist/gen-wallets.js <count 1-100>");
  process.exit(1);
}

const keysFile = resolve(process.cwd(), "wallets.txt");
const addrFile = resolve(process.cwd(), "wallets-addresses.txt");

const lines: string[] = [];
console.log(`Generating ${n} wallets. Fund each address below with MON.\n`);
for (let i = 0; i < n; i++) {
  const w = ethers.Wallet.createRandom();
  appendFileSync(keysFile, w.privateKey + "\n");
  lines.push(w.address);
  console.log(`${i + 1}. ${w.address}`);
}
const header = existsSync(addrFile) ? "" : "# Addresses to fund with MON\n";
appendFileSync(addrFile, header + lines.join("\n") + "\n");

console.log(`\nKeys saved to wallets.txt. Addresses saved to wallets-addresses.txt.`);
console.log(`Fund every address above, then run the multi snipe.`);
