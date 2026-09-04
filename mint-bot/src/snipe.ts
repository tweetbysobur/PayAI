import "dotenv/config";
import dns from "node:dns";
// Force IPv4 DNS resolution first. Some Windows setups fail Node's IPv6 name
// lookup with EAI_AGAIN even when the network is fine; this avoids that.
dns.setDefaultResultOrder("ipv4first");
import { ethers } from "ethers";
import { getChain, getProvider, txUrl } from "./chain.js";
import { prepareMint } from "./mint.js";
import { getContract, isConfigured } from "./store.js";

/**
 * Snipe script: fires the mint transaction as fast as possible, retrying until
 * one lands or attempts run out. Use for a competitive open mint where typing
 * /mint in Telegram is too slow.
 *
 * Reads the same contract config as the bot (NFT_CONTRACT_ADDRESS,
 * NFT_MINT_FUNCTION, NFT_MINT_ARGS, NFT_MINT_PRICE), plus:
 *   SNIPE_PRIVATE_KEY   wallet that mints and pays (falls back to CUSTODIAL_PRIVATE_KEY)
 *   SNIPE_QUANTITY      how many per attempt (default 1)
 *   SNIPE_MAX_FEE_GWEI  maxFeePerGas in gwei (default: provider suggestion x2)
 *   SNIPE_PRIORITY_GWEI maxPriorityFeePerGas in gwei (default 2)
 *   SNIPE_ATTEMPTS      max attempts (default 0 = unlimited: keep firing until it lands)
 *   SNIPE_INTERVAL_MS   delay between attempts (default 400)
 *   SNIPE_START_ISO     optional ISO time to wait for before firing (e.g. 2026-09-04T15:00:00Z)
 *
 * Run:  npm run snipe    (after npm run build), or  npx tsx src/snipe.ts
 */

function normalizeKey(k: string): string {
  const raw = k.trim().replace(/^0x/i, "");
  return raw ? `0x${raw}` : "";
}

async function waitUntil(startIso?: string) {
  if (!startIso) return;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) throw new Error(`Bad SNIPE_START_ISO: ${startIso}`);
  const now = Date.now();
  if (now >= start) return;
  console.log(`Waiting until ${startIso} (${Math.round((start - now) / 1000)}s)...`);
  // Sleep until ~500ms before start, then busy-check for precision.
  await new Promise((r) => setTimeout(r, Math.max(0, start - now - 500)));
  while (Date.now() < start) {
    // tight wait for the last moment
  }
}

async function main() {
  if (!isConfigured()) {
    throw new Error("No NFT contract set. Set NFT_CONTRACT_ADDRESS and mint fields first.");
  }
  const keySrc = process.env.SNIPE_PRIVATE_KEY || process.env.CUSTODIAL_PRIVATE_KEY || "";
  const key = normalizeKey(keySrc);
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error("Set SNIPE_PRIVATE_KEY to the minting wallet's private key.");
  }

  const provider = getProvider();
  const wallet = new ethers.Wallet(key, provider);
  const chain = getChain();
  const cfg = getContract();

  const quantity = Number(process.env.SNIPE_QUANTITY || "1");
  const attempts = Number(process.env.SNIPE_ATTEMPTS || "0"); // 0 = unlimited
  const unlimited = attempts <= 0;
  const intervalMs = Number(process.env.SNIPE_INTERVAL_MS || "400");
  const priorityGwei = process.env.SNIPE_PRIORITY_GWEI || "2";

  const prepared = prepareMint(wallet.address, quantity);
  // Raw-input override: paste the exact input data (and value) from a known-good
  // public mint transaction to replay it verbatim, bypassing ABI encoding.
  const rawData = (process.env.SNIPE_RAW_DATA || "").trim();
  const data = rawData ? (rawData.startsWith("0x") ? rawData : `0x${rawData}`) : prepared.data;
  const value = process.env.SNIPE_VALUE ? ethers.parseEther(process.env.SNIPE_VALUE) : prepared.value;

  const fee = await provider.getFeeData();
  const maxFee = process.env.SNIPE_MAX_FEE_GWEI
    ? ethers.parseUnits(process.env.SNIPE_MAX_FEE_GWEI, "gwei")
    : (fee.maxFeePerGas ?? ethers.parseUnits("50", "gwei")) * 2n;
  const priorityFee = ethers.parseUnits(priorityGwei, "gwei");

  console.log(`Sniping ${cfg.address} on ${chain.name} as ${wallet.address}`);
  console.log(`fn=${cfg.mintFunction}(${cfg.mintArgs}) qty=${quantity} price=${cfg.price} ${chain.symbol}`);
  console.log(`maxFee=${ethers.formatUnits(maxFee, "gwei")} gwei priority=${priorityGwei} gwei`);

  // Affordability guard: refuse to run unless the wallet covers price + gas.
  const balance = await provider.getBalance(wallet.address);
  const gasBuffer = maxFee * 300_000n;
  const needed = value + gasBuffer;
  if (balance < needed) {
    console.log(
      `Balance ${ethers.formatEther(balance)} MON is below needed ~${ethers.formatEther(needed)} MON (price + gas). Not minting.`,
    );
    process.exit(1);
  }

  await waitUntil(process.env.SNIPE_START_ISO);

  let nonce = await provider.getTransactionCount(wallet.address, "pending");
  console.log(unlimited ? "Auto mode: firing until it lands. Ctrl+C to stop." : `Up to ${attempts} attempts.`);

  for (let i = 1; unlimited || i <= attempts; i++) {
    try {
      const tx = await wallet.sendTransaction({
        to: prepared.to,
        data,
        value,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priorityFee,
        nonce,
      });
      console.log(`Attempt ${i}: sent ${tx.hash}`);
      const rc = await tx.wait(1);
      if (rc && rc.status === 1) {
        console.log(`Minted. ${txUrl(tx.hash)}`);
        return;
      }
      console.log(`Attempt ${i}: reverted, retrying...`);
      nonce++;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // Nonce already used means a prior attempt likely landed — re-sync.
      if (/nonce/i.test(msg)) {
        nonce = await provider.getTransactionCount(wallet.address, "pending");
      }
      console.log(`Attempt ${i}: ${msg.split("\n")[0]}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.log("Out of attempts. No mint landed.");
  process.exit(1);
}

main().catch((e) => {
  console.error("Snipe error:", e.message || e);
  process.exit(1);
});
