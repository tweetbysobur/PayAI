const hre = require("hardhat");

/**
 * READ-ONLY. Part of the MerchantRegistry migration plan -- see
 * contracts/MERCHANT_REGISTRY_MIGRATION.md for the full sequence this fits
 * into. This script changes nothing on-chain; it only reads the CURRENT
 * live MerchantRegistry and writes a timestamped JSON snapshot that
 * deploy-and-migrate-merchant-registry.js later replays onto a fresh
 * registry via registerMerchantWithHistory(), preserving each merchant's
 * volume/paymentCount/registeredAt instead of resetting them to 0.
 *
 * What it captures:
 *   - Every registered merchant (wallet, name, active, volume, paymentCount,
 *     registeredAt) via allMerchants() + getMerchant() for each -- the same
 *     read shape the live dashboard already uses (lib/monad/contracts.ts's
 *     getOnchainMerchants()).
 *   - Current isManager/isRecorder holders, reconstructed by replaying
 *     ManagerSet/RecorderSet events from the registry's deployment block to
 *     the chain head and taking the LATEST event per address (a grant can be
 *     revoked and re-granted, and the mappings themselves are not
 *     enumerable on-chain -- there is no allManagers()). isRegistrar is
 *     deliberately NOT queried here: it doesn't exist on the pre-migration
 *     registry (it's part of the L-02 fix), so it gets granted fresh on the
 *     new registry, not migrated.
 *
 * RATE LIMITING & BLOCK RANGE: Monad's mainnet RPC caps eth_getLogs at a
 * 100-block range per request and 50 requests/second overall (confirmed
 * while building investigate-vault-reservation-readonly.js). This script
 * uses the same fix: every getLogs call is <=100 blocks, and every request
 * (block lookups + log scans) goes through a shared rate limiter safely
 * under 50/sec. It also does NOT require you to already know the registry's
 * deployment block -- if REGISTRY_DEPLOY_BLOCK is unset, it derives one via
 * binary search over block HEADERS (eth_getBlockByNumber timestamps, not
 * eth_getCode/state, so it works without archive access) from this
 * registry's known deploy timestamp (see KNOWN_REGISTRY_DEPLOY_TIMESTAMP_ISO
 * below), the same technique already proven for the AutomationVault.
 *
 * Required env:
 *   MERCHANT_REGISTRY_ADDRESS   -- the LIVE registry to snapshot. Do not
 *                                  trust contracts/deployed-*.json alone;
 *                                  confirm the actual address from Vercel
 *                                  env / on-chain first (see the migration
 *                                  plan's pre-flight step).
 * Optional:
 *   REGISTRY_DEPLOY_BLOCK       -- explicit starting block. Skips
 *                                  auto-detection entirely if set (e.g. from
 *                                  a block explorer lookup -- fastest,
 *                                  zero-RPC-cost option).
 *   DEPLOY_TIMESTAMP_ISO        -- override the timestamp used for
 *                                  auto-detection.
 *   DEPLOY_BLOCK_SAFETY_MARGIN  -- blocks to back off from the detected
 *                                  timestamp match (default 2000).
 *   EVENT_SCAN_CHUNK_SIZE       -- blocks per getLogs call, hard-capped at
 *                                  100 regardless of what's passed.
 *   RPC_MAX_REQUESTS_PER_SECOND -- shared rate limit across ALL requests
 *                                  (default 20, safely under the RPC's 50).
 */

const MAX_RANGE = 100;
// contracts/deployed-suite-v3-fresh.json records this registry
// (0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb) and the AutomationVault as
// deployed in the same script run, same "deployedAt" timestamp -- the
// registry is deployed FIRST in that script (step 1, before the executor
// and vault), so its true block is at or slightly before this.
const KNOWN_REGISTRY_DEPLOY_TIMESTAMP_ISO = "2026-07-08T23:16:18.344Z";

class RateLimiter {
  constructor(maxPerSecond) {
    this.maxPerSecond = maxPerSecond;
    this.timestamps = [];
  }
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 1000);
      if (this.timestamps.length < this.maxPerSecond) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = 1000 - (now - this.timestamps[0]) + 5;
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 5)));
    }
  }
}

async function findDeploymentBlockByTimestamp(provider, limiter, targetTimestampSec, latest, safetyMargin) {
  await limiter.acquire();
  const latestBlock = await provider.getBlock(latest);
  if (!latestBlock) return { error: `could not fetch latest block ${latest}` };
  if (latestBlock.timestamp < targetTimestampSec) {
    return { error: "target deploy timestamp is after the current latest block -- clock mismatch, refusing to guess" };
  }
  let lo = 0;
  let hi = latest;
  let calls = 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    await limiter.acquire();
    calls++;
    const block = await provider.getBlock(mid);
    if (!block) return { error: `getBlock(${mid}) returned null` };
    if (block.timestamp < targetTimestampSec) lo = mid + 1;
    else hi = mid;
  }
  return { matchedBlock: lo, blockWithMargin: Math.max(lo - safetyMargin, 0), calls };
}

async function scanEventsInChunks(provider, limiter, registry, fromBlock, toBlock, chunkSize) {
  const managerEvents = [];
  const recorderEvents = [];
  const totalWindows = Math.ceil((toBlock - fromBlock + 1) / chunkSize);
  console.log(`    ${totalWindows} window(s) of <=${chunkSize} blocks, rate-limited to ${limiter.maxPerSecond}/sec`);
  console.log(`    estimated minimum time: ~${Math.ceil((totalWindows * 2) / limiter.maxPerSecond)}s`);

  let completed = 0;
  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, toBlock);
    await limiter.acquire();
    const mgr = await registry.queryFilter(registry.filters.ManagerSet(), from, to);
    await limiter.acquire();
    const rec = await registry.queryFilter(registry.filters.RecorderSet(), from, to);
    managerEvents.push(...mgr);
    recorderEvents.push(...rec);
    completed++;
    if (completed % 20 === 0 || from + chunkSize > toBlock) {
      console.log(`    progress: ${completed}/${totalWindows} windows, ${managerEvents.length} ManagerSet + ${recorderEvents.length} RecorderSet so far`);
    }
  }
  return { managerEvents, recorderEvents };
}

async function main() {
  const registryAddress = process.env.MERCHANT_REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("Set MERCHANT_REGISTRY_ADDRESS to the LIVE registry address.");
  const chunkSize = Math.min(Number(process.env.EVENT_SCAN_CHUNK_SIZE ?? MAX_RANGE), MAX_RANGE);
  const maxReqPerSec = Number(process.env.RPC_MAX_REQUESTS_PER_SECOND ?? 20);
  const safetyMargin = Number(process.env.DEPLOY_BLOCK_SAFETY_MARGIN ?? 2000);
  const limiter = new RateLimiter(maxReqPerSec);

  console.log("Network:", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Snapshotting MerchantRegistry:", registryAddress);

  const registry = await hre.ethers.getContractAt("MerchantRegistry", registryAddress);
  const provider = hre.ethers.provider;

  await limiter.acquire();
  const latest = await provider.getBlockNumber();

  let deployBlock;
  if (process.env.REGISTRY_DEPLOY_BLOCK !== undefined) {
    deployBlock = Number(process.env.REGISTRY_DEPLOY_BLOCK);
    console.log(`Deploy block: ${deployBlock} (explicitly set via REGISTRY_DEPLOY_BLOCK)`);
  } else {
    const targetIso = process.env.DEPLOY_TIMESTAMP_ISO || KNOWN_REGISTRY_DEPLOY_TIMESTAMP_ISO;
    console.log(`REGISTRY_DEPLOY_BLOCK not set -- deriving it from the known deploy timestamp (${targetIso}) via`);
    console.log("binary search over block headers (not state, works without archive access)...");
    const result = await findDeploymentBlockByTimestamp(provider, limiter, Math.floor(new Date(targetIso).getTime() / 1000), latest, safetyMargin);
    if (result.error) {
      throw new Error(`Deployment-block auto-detection failed: ${result.error}. Set REGISTRY_DEPLOY_BLOCK explicitly and rerun.`);
    }
    deployBlock = result.blockWithMargin;
    console.log(`Matched block: ${result.matchedBlock} (${result.calls} calls). Using deploy block ${deployBlock} after ${safetyMargin}-block safety margin.`);
  }

  const owner = await registry.owner();
  console.log("Current owner:", owner);

  console.log("\n1/2 Reading registered merchants...");
  const addresses = await registry.allMerchants();
  console.log(`    ${addresses.length} merchant(s) found. Reading details...`);
  const merchants = [];
  for (const wallet of addresses) {
    await limiter.acquire();
    const m = await registry.getMerchant(wallet);
    merchants.push({
      wallet: m.wallet,
      name: m.name,
      active: m.active,
      volume: m.volume.toString(),
      paymentCount: m.paymentCount.toString(),
      registeredAt: Number(m.registeredAt),
    });
  }
  console.log(`    done. ${merchants.filter((m) => !m.active).length} inactive.`);

  console.log("\n2/2 Reconstructing isManager/isRecorder from event history...");
  const { managerEvents, recorderEvents } = await scanEventsInChunks(provider, limiter, registry, deployBlock, latest, chunkSize);
  console.log(`    ${managerEvents.length} ManagerSet event(s), ${recorderEvents.length} RecorderSet event(s) found.`);

  function latestByAddress(events) {
    const byAddr = new Map();
    for (const e of events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)) {
      byAddr.set(e.args.account.toLowerCase(), e.args.allowed);
    }
    return [...byAddr.entries()].filter(([, allowed]) => allowed).map(([addr]) => addr);
  }
  const currentManagers = latestByAddress(managerEvents);
  const currentRecorders = latestByAddress(recorderEvents);
  console.log("    Current managers:", currentManagers);
  console.log("    Current recorders:", currentRecorders);

  const snapshot = {
    network: hre.network.name,
    chainId: Number(hre.network.config.chainId),
    registryAddress,
    owner,
    deployBlockUsed: deployBlock,
    snapshottedAt: new Date().toISOString(),
    snapshottedAtBlock: latest,
    merchants,
    currentManagers,
    currentRecorders,
  };

  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", `merchant-registry-snapshot-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ Snapshot written to ${outPath}`);
  console.log("   Pass this file to deploy-and-migrate-merchant-registry.js via SNAPSHOT_FILE=<path>.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
