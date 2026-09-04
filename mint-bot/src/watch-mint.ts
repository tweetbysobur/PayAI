import "dotenv/config";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { getChain, getProvider, txUrl } from "./chain.js";

/**
 * Price-watch auto mint for the Chog-style staged mint contract.
 *
 * Watches a stage's on-chain price. When the stage is open and the price is at
 * or below your budget, it mints from every wallet in wallets.txt in parallel,
 * simulating each mint first so it never spends gas on a call that would fail.
 *
 * The mint function is:
 *   mint(uint8 stage, uint256 qty, uint8 allotment, bytes32[] proof) payable
 * For an open stage (merkleRoot == 0) the proof is empty.
 *
 * Env:
 *   NFT_CONTRACT_ADDRESS   the mint contract (required)
 *   WATCH_STAGE            stage number to watch (default 5 = public)
 *   WATCH_MAX_PRICE        max price per NFT you will pay, in MON (required)
 *   WATCH_QTY             quantity per wallet (default 1)
 *   WATCH_ALLOTMENT       allotment arg (default: stage maxPerWallet)
 *   WATCH_POLL_MS         poll interval (default 1000)
 *   SNIPE_MAX_FEE_GWEI / SNIPE_PRIORITY_GWEI   gas (as in the snipe scripts)
 *
 * Wallets: one private key per line in wallets.txt.
 * Run:  node dist/watch-mint.js
 */

const ABI = [
  "function stageInfo(uint8) view returns (bytes32 merkleRoot, uint40 start, uint40 end, uint16 cap, uint16 minted, uint8 maxPerWallet, uint96 price)",
  "function currentStage() view returns (uint8)",
  "function mint(uint8 stage, uint256 qty, uint8 allotment, bytes32[] proof) payable",
];

function loadKeys(): string[] {
  const file = resolve(process.cwd(), "wallets.txt");
  if (!existsSync(file)) throw new Error("Create wallets.txt with one private key per line.");
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => `0x${l.replace(/^0x/i, "")}`)
    .filter((k) => /^0x[a-fA-F0-9]{64}$/.test(k));
}

const minted = new Set<string>(); // wallet addresses that already succeeded

async function tryMint(
  wallet: ethers.Wallet,
  contract: ethers.Contract,
  iface: ethers.Interface,
  to: string,
  stage: number,
  qty: number,
  allotment: number,
  price: bigint,
  maxFee: bigint,
  priorityFee: bigint,
): Promise<void> {
  const label = wallet.address.slice(0, 10);
  try {
    if (minted.has(wallet.address)) return;
    const balance = await wallet.provider!.getBalance(wallet.address);
    const needed = price * BigInt(qty) + maxFee * 300_000n;
    if (balance < needed) {
      return; // silently skip; can't afford this round
    }
    const data = iface.encodeFunctionData("mint", [stage, qty, allotment, []]);
    const value = price * BigInt(qty);
    // Simulate first — no gas spent if it would revert.
    await wallet.provider!.call({ to, from: wallet.address, data, value });
    // Simulation passed: send for real.
    const tx = await wallet.sendTransaction({
      to,
      data,
      value,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
    });
    console.log(`${label}: sent ${tx.hash}`);
    const rc = await tx.wait(1);
    if (rc && rc.status === 1) {
      console.log(`${label}: MINTED ${txUrl(tx.hash)}`);
      minted.add(wallet.address);
    }
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0];
    // Common while closed: "not open", "stage", "proof", revert. Stay quiet-ish.
    console.log(`${label}: ${msg}`);
  }
}

async function main() {
  const address = (process.env.NFT_CONTRACT_ADDRESS || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Set NFT_CONTRACT_ADDRESS.");
  if (!process.env.WATCH_MAX_PRICE) throw new Error("Set WATCH_MAX_PRICE (max MON per NFT you will pay).");

  const stage = Number(process.env.WATCH_STAGE || "5");
  const qty = Number(process.env.WATCH_QTY || "1");
  const maxPrice = ethers.parseEther(process.env.WATCH_MAX_PRICE);
  const pollMs = Number(process.env.WATCH_POLL_MS || "1000");

  const provider = getProvider();
  const chain = getChain();
  const contract = new ethers.Contract(address, ABI, provider);
  const iface = new ethers.Interface(ABI);

  const feeData = await provider.getFeeData();
  const maxFee = process.env.SNIPE_MAX_FEE_GWEI
    ? ethers.parseUnits(process.env.SNIPE_MAX_FEE_GWEI, "gwei")
    : (feeData.maxFeePerGas ?? ethers.parseUnits("50", "gwei")) * 2n;
  const priorityFee = ethers.parseUnits(process.env.SNIPE_PRIORITY_GWEI || "2", "gwei");

  const wallets = loadKeys().map((k) => new ethers.Wallet(k, provider));
  if (wallets.length === 0) throw new Error("No valid keys in wallets.txt.");

  console.log(`Watching stage ${stage} on ${chain.name} at ${address}`);
  console.log(`Wallets: ${wallets.length}. Will mint when price <= ${process.env.WATCH_MAX_PRICE} ${chain.symbol}.`);

  let lastLog = 0;
  for (;;) {
    try {
      const info = await contract.stageInfo(stage);
      const price: bigint = info.price;
      const start = Number(info.start);
      const end = Number(info.end);
      const cap = Number(info.cap);
      const mintedCount = Number(info.minted);
      const maxPerWallet = Number(info.maxPerWallet);
      const allotment = Number(process.env.WATCH_ALLOTMENT || maxPerWallet || 1);
      const now = Math.floor(Date.now() / 1000);
      const open = now >= start && now <= end && mintedCount < cap;

      const affordable = price <= maxPrice;
      // Log a heartbeat at most every 15s.
      if (Date.now() - lastLog > 15_000) {
        console.log(
          `price=${ethers.formatEther(price)} ${chain.symbol} open=${open} minted=${mintedCount}/${cap} ` +
            `(${affordable ? "affordable" : "too high"})`,
        );
        lastLog = Date.now();
      }

      if (open && affordable && minted.size < wallets.length) {
        await Promise.allSettled(
          wallets.map((w) =>
            tryMint(w, contract, iface, address, stage, qty, allotment, price, maxFee, priorityFee),
          ),
        );
        if (minted.size >= wallets.length) {
          console.log("All wallets minted. Done.");
          return;
        }
      }
    } catch (e) {
      console.log(`watch error: ${(e as Error).message.split("\n")[0]}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
