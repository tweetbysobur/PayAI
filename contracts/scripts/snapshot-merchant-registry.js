const hre = require("hardhat");

/**
 * READ-ONLY. Part of the MerchantRegistry migration plan -- see
 * contracts/MERCHANT_REGISTRY_MIGRATION.md for the full sequence this fits
 * into. This script changes nothing on-chain; it only reads the CURRENT
 * live MerchantRegistry and writes a timestamped JSON snapshot that
 * deploy-and-migrate-merchant-registry.js later replays onto a fresh
 * registry.
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
 * Required env:
 *   MERCHANT_REGISTRY_ADDRESS   -- the LIVE registry to snapshot. Do not
 *                                  trust contracts/deployed-*.json alone;
 *                                  confirm the actual address from Vercel
 *                                  env / on-chain first (see the migration
 *                                  plan's pre-flight step).
 *   REGISTRY_DEPLOY_BLOCK       -- block number the registry was deployed
 *                                  at, so the event scan doesn't have to
 *                                  replay the whole chain. Look this up from
 *                                  the deployment tx on the explorer.
 * Optional:
 *   EVENT_SCAN_CHUNK_SIZE       -- blocks per getLogs call (default 10000),
 *                                  tune down if the RPC rate-limits large
 *                                  ranges.
 */
async function main() {
  const registryAddress = process.env.MERCHANT_REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("Set MERCHANT_REGISTRY_ADDRESS to the LIVE registry address.");
  const deployBlock = process.env.REGISTRY_DEPLOY_BLOCK ? Number(process.env.REGISTRY_DEPLOY_BLOCK) : null;
  if (deployBlock === null) throw new Error("Set REGISTRY_DEPLOY_BLOCK -- look up the registry's deployment tx block on the explorer.");
  const chunkSize = Number(process.env.EVENT_SCAN_CHUNK_SIZE ?? "10000");

  console.log("Network:", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Snapshotting MerchantRegistry:", registryAddress);

  const registry = await hre.ethers.getContractAt("MerchantRegistry", registryAddress);

  const owner = await registry.owner();
  console.log("Current owner:", owner);

  console.log("\n1/2 Reading registered merchants...");
  const addresses = await registry.allMerchants();
  console.log(`    ${addresses.length} merchant(s) found. Reading details...`);
  const merchants = [];
  for (const wallet of addresses) {
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
  const latestBlock = await hre.ethers.provider.getBlockNumber();
  const managerEvents = [];
  const recorderEvents = [];
  for (let from = deployBlock; from <= latestBlock; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, latestBlock);
    process.stdout.write(`    scanning blocks ${from}-${to}...\r`);
    const [mgr, rec] = await Promise.all([
      registry.queryFilter(registry.filters.ManagerSet(), from, to),
      registry.queryFilter(registry.filters.RecorderSet(), from, to),
    ]);
    managerEvents.push(...mgr);
    recorderEvents.push(...rec);
  }
  console.log(`\n    ${managerEvents.length} ManagerSet event(s), ${recorderEvents.length} RecorderSet event(s) found.`);

  // Latest event per address wins -- a grant can be revoked then re-granted.
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
    snapshottedAt: new Date().toISOString(),
    snapshottedAtBlock: latestBlock,
    merchants,
    currentManagers,
    currentRecorders,
  };

  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", `merchant-registry-snapshot-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n✅ Snapshot written to ${outPath}`);
  console.log("   Review it, get product sign-off on the volume/paymentCount question in");
  console.log("   MERCHANT_REGISTRY_MIGRATION.md, then pass this file to");
  console.log("   deploy-and-migrate-merchant-registry.js via SNAPSHOT_FILE=<path>.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
