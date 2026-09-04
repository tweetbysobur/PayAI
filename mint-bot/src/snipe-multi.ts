import "dotenv/config";
import dns from "node:dns";
// Force IPv4 DNS resolution first (avoids EAI_AGAIN on some Windows/IPv6 setups).
dns.setDefaultResultOrder("ipv4first");
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { getChain, getProvider, txUrl } from "./chain.js";
import { prepareMint } from "./mint.js";
import { getContract, isConfigured } from "./store.js";

/**
 * Multi-wallet auto snipe. Runs an independent mint loop for every wallet in
 * parallel. One wallet failing (revert, out of gas, bad key, per-wallet cap
 * hit) never stops the others — each loop is isolated.
 *
 * Wallets: one private key per line in `wallets.txt` (same folder). Blank lines
 * and lines starting with # are ignored. The 0x prefix is optional. Keep this
 * file private; it is gitignored.
 *
 * Contract + gas config are the same env vars the single snipe uses:
 *   NFT_CONTRACT_ADDRESS, NFT_MINT_FUNCTION, NFT_MINT_ARGS, NFT_MINT_PRICE,
 *   SNIPE_QUANTITY, SNIPE_MAX_FEE_GWEI, SNIPE_PRIORITY_GWEI,
 *   SNIPE_ATTEMPTS (0 = unlimited), SNIPE_INTERVAL_MS, SNIPE_START_ISO.
 *
 * Each wallet needs its own MON for the mint price plus gas.
 *
 * Run:  npm run build  then  node dist/snipe-multi.js
 */

function loadKeys(): string[] {
  const file = resolve(process.cwd(), "wallets.txt");
  if (!existsSync(file)) throw new Error("Create wallets.txt with one private key per line.");
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => `0x${l.replace(/^0x/i, "")}`);
}

async function waitUntil(startIso?: string) {
  if (!startIso) return;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) throw new Error(`Bad SNIPE_START_ISO: ${startIso}`);
  const delta = start - Date.now();
  if (delta <= 0) return;
  console.log(`All wallets waiting until ${startIso} (${Math.round(delta / 1000)}s)...`);
  await new Promise((r) => setTimeout(r, Math.max(0, delta - 500)));
  while (Date.now() < start) {
    // tight wait for the last moment
  }
}

/** One wallet's isolated loop. Never throws; logs and returns. */
async function runWallet(
  key: string,
  idx: number,
  opts: {
    provider: ethers.JsonRpcProvider;
    quantity: number;
    attempts: number;
    unlimited: boolean;
    intervalMs: number;
    maxFee: bigint;
    priorityFee: bigint;
  },
): Promise<void> {
  let label = `wallet#${idx + 1}`;
  try {
    const wallet = new ethers.Wallet(key, opts.provider);
    label = `${label} ${wallet.address.slice(0, 8)}`;
    const prepared = prepareMint(wallet.address, opts.quantity);

    // Affordability guard: skip this wallet unless it can cover the mint price
    // plus a gas buffer. Protects against overspend and wasted gas.
    const balance = await opts.provider.getBalance(wallet.address);
    const gasBuffer = opts.maxFee * 300_000n; // generous gas headroom
    const needed = prepared.value + gasBuffer;
    if (balance < needed) {
      console.log(
        `${label}: skipped, balance ${ethers.formatEther(balance)} < needed ~${ethers.formatEther(needed)} MON`,
      );
      return;
    }

    let nonce = await opts.provider.getTransactionCount(wallet.address, "pending");

    for (let i = 1; opts.unlimited || i <= opts.attempts; i++) {
      try {
        const tx = await wallet.sendTransaction({
          to: prepared.to,
          data: prepared.data,
          value: prepared.value,
          maxFeePerGas: opts.maxFee,
          maxPriorityFeePerGas: opts.priorityFee,
          nonce,
        });
        console.log(`${label}: attempt ${i} sent ${tx.hash}`);
        const rc = await tx.wait(1);
        if (rc && rc.status === 1) {
          console.log(`${label}: MINTED ${txUrl(tx.hash)}`);
          return;
        }
        console.log(`${label}: attempt ${i} reverted, retrying`);
        nonce++;
      } catch (e) {
        const msg = (e as Error).message || String(e);
        if (/nonce/i.test(msg)) {
          nonce = await opts.provider.getTransactionCount(wallet.address, "pending");
        }
        console.log(`${label}: ${msg.split("\n")[0]}`);
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
    console.log(`${label}: out of attempts, no mint`);
  } catch (e) {
    // Bad key or setup for this wallet only. Isolated: others keep running.
    console.log(`${label}: skipped (${(e as Error).message.split("\n")[0]})`);
  }
}

async function main() {
  if (!isConfigured()) {
    throw new Error("No NFT contract set. Set NFT_CONTRACT_ADDRESS and mint fields first.");
  }
  const keys = loadKeys();
  const valid = keys.filter((k) => /^0x[a-fA-F0-9]{64}$/.test(k));
  if (valid.length === 0) throw new Error("No valid private keys in wallets.txt.");
  if (valid.length !== keys.length) {
    console.log(`Warning: ${keys.length - valid.length} line(s) in wallets.txt are not valid keys; skipping them.`);
  }

  const provider = getProvider();
  const chain = getChain();
  const cfg = getContract();
  const fee = await provider.getFeeData();
  const maxFee = process.env.SNIPE_MAX_FEE_GWEI
    ? ethers.parseUnits(process.env.SNIPE_MAX_FEE_GWEI, "gwei")
    : (fee.maxFeePerGas ?? ethers.parseUnits("50", "gwei")) * 2n;
  const priorityFee = ethers.parseUnits(process.env.SNIPE_PRIORITY_GWEI || "2", "gwei");
  const attempts = Number(process.env.SNIPE_ATTEMPTS || "0");

  console.log(`Multi-wallet snipe on ${chain.name}: ${valid.length} wallets`);
  console.log(`target=${cfg.address} fn=${cfg.mintFunction}(${cfg.mintArgs}) price=${cfg.price} ${chain.symbol}`);
  console.log(`maxFee=${ethers.formatUnits(maxFee, "gwei")} gwei priority=${ethers.formatUnits(priorityFee, "gwei")} gwei`);

  await waitUntil(process.env.SNIPE_START_ISO);

  const opts = {
    provider,
    quantity: Number(process.env.SNIPE_QUANTITY || "1"),
    attempts,
    unlimited: attempts <= 0,
    intervalMs: Number(process.env.SNIPE_INTERVAL_MS || "400"),
    maxFee,
    priorityFee,
  };

  // allSettled: every wallet runs to its own end, isolated from the others.
  await Promise.allSettled(valid.map((k, i) => runWallet(k, i, opts)));
  console.log("All wallet loops finished.");
}

main().catch((e) => {
  console.error("Snipe error:", e.message || e);
  process.exit(1);
});
