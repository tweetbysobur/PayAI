const hre = require("hardhat");
const fs = require("fs");

/**
 * The actual MerchantRegistry migration -- see
 * contracts/MERCHANT_REGISTRY_MIGRATION.md for the full plan this fits into.
 * NOT run by anyone yet. Requires a snapshot from snapshot-merchant-
 * registry.js and product sign-off on the volume/paymentCount question in
 * that plan document before running this for real.
 *
 * Deploys a fresh MerchantRegistry (carrying the L-02 isRegistrar fix) and a
 * fresh PaymentExecutor pointed at it (the registry reference is immutable,
 * so a new registry always means a new executor too -- see
 * PaymentExecutor.sol's `merchantRegistry` field). While the deployer still
 * holds the fresh registry's initial admin rights, this script:
 *   1. Authorizes the new executor as recorder.
 *   2. Grants the agent isRegistrar (the L-02 fix's whole point: the agent
 *      can register new merchants without full manager power).
 *   3. Re-grants every OTHER historical manager from the snapshot (NOT the
 *      agent -- the agent is deliberately registrar-only going forward).
 *   4. Replays every snapshotted merchant via registerMerchant(), then
 *      setActive(false) for any that were inactive.
 *   5. Grants the real owner (cold wallet) manager rights, revokes the
 *      deployer's own manager grant, and transfers ownership.
 * Every step above is deployer-signed -- because this is a FRESH registry,
 * the deployer holds its initial admin rights, unlike a redeploy that
 * reuses an already-cold-owned contract (compare deploy-suite-v4-
 * ultrafuzz.js, which has to print setRecorder as a manual cold-wallet step
 * for exactly that reason). No cold-wallet signature is needed during this
 * migration itself -- only for the real owner's OWN future admin actions
 * after handoff.
 *
 * volume/paymentCount are NOT backfilled -- every merchant starts at 0/0 on
 * the new registry. That's a deliberate, documented gap (see the migration
 * plan's "What will NOT carry over automatically" section), not an
 * oversight -- do not add ad-hoc backfill logic here without a product
 * decision first.
 *
 * Required env:
 *   MONAD_AGENT_PRIVATE_KEY   -- deployer/agent key (pays gas, becomes the
 *                                new executor's agent AND gets isRegistrar).
 *   SNAPSHOT_FILE             -- path to the JSON from snapshot-merchant-
 *                                registry.js.
 *   REAL_OWNER_ADDRESS        -- the cold wallet that should own the new
 *                                registry/executor. Defaults to the
 *                                snapshot's recorded `owner` if unset --
 *                                confirm that's still correct before relying
 *                                on the default.
 * Optional (defaults match the July fresh-deploy caps):
 *   DAILY_CAP, MAX_TX_AMOUNT                       (USDC base units, 6dp)
 *   DAILY_CAP_NATIVE_MON, MAX_TX_AMOUNT_NATIVE_MON  (whole MON)
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const snapshotPath = process.env.SNAPSHOT_FILE;
  if (!snapshotPath) throw new Error("Set SNAPSHOT_FILE to the JSON produced by snapshot-merchant-registry.js.");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

  const agentAddr = deployer.address;
  const ownerAddr = process.env.REAL_OWNER_ADDRESS ?? snapshot.owner;
  if (!ownerAddr) throw new Error("Set REAL_OWNER_ADDRESS -- the snapshot had no owner recorded either.");
  if (ownerAddr.toLowerCase() === agentAddr.toLowerCase()) {
    throw new Error("REAL_OWNER_ADDRESS must differ from the agent/deployer address.");
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:       ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer/Agent:", agentAddr, "(pays gas, becomes new executor's agent + registrar)");
  console.log("Real owner:    ", ownerAddr, "(cold wallet -- admin only, post-migration)");
  console.log("Snapshot:      ", snapshotPath, `(${snapshot.merchants.length} merchants, from ${snapshot.snapshottedAt})`);
  console.log("Balance:       ", hre.ethers.formatEther(balance), "MON");
  if (balance === 0n) throw new Error(`Deployer has 0 MON. Fund ${agentAddr}.`);

  const DAILY_CAP = BigInt(process.env.DAILY_CAP ?? "2000000000000");
  const MAX_TX_AMOUNT = BigInt(process.env.MAX_TX_AMOUNT ?? "1000000000000");
  const DAILY_CAP_NATIVE = hre.ethers.parseEther(process.env.DAILY_CAP_NATIVE_MON ?? "2000000");
  const MAX_TX_AMOUNT_NATIVE = hre.ethers.parseEther(process.env.MAX_TX_AMOUNT_NATIVE_MON ?? "1000000");

  console.log("\n1/6 Deploying fresh MerchantRegistry (carries the L-02 isRegistrar fix)…");
  const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
  const registry = await Registry.deploy({ gasLimit: 1_500_000 });
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("    MerchantRegistry:", registryAddr);

  console.log("\n2/6 Deploying PaymentExecutor pointed at the new registry (immutable reference)…");
  const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
  const executor = await Executor.deploy(
    registryAddr, DAILY_CAP, ownerAddr, agentAddr, MAX_TX_AMOUNT, DAILY_CAP_NATIVE, MAX_TX_AMOUNT_NATIVE,
    { gasLimit: 3_500_000 },
  );
  await executor.waitForDeployment();
  const executorAddr = await executor.getAddress();
  console.log("    PaymentExecutor:", executorAddr);

  console.log("\n3/6 Wiring roles on the fresh registry (deployer still holds initial admin rights)…");
  let tx = await registry.setRecorder(executorAddr, true, { gasLimit: 100_000 });
  await tx.wait();
  console.log("    setRecorder(newExecutor, true) done.");
  tx = await registry.setRegistrar(agentAddr, true, { gasLimit: 100_000 });
  await tx.wait();
  console.log("    setRegistrar(agent, true) done -- the L-02 fix: agent can register merchants, nothing more.");

  const otherManagers = (snapshot.currentManagers ?? []).filter(
    (a) => a.toLowerCase() !== agentAddr.toLowerCase() && a.toLowerCase() !== ownerAddr.toLowerCase(),
  );
  for (const addr of otherManagers) {
    tx = await registry.setManager(addr, true, { gasLimit: 100_000 });
    await tx.wait();
    console.log(`    setManager(${addr}, true) done (carried over from snapshot).`);
  }
  if ((snapshot.currentManagers ?? []).some((a) => a.toLowerCase() === agentAddr.toLowerCase())) {
    console.log(`    NOTE: the old registry had the agent (${agentAddr}) as a full manager -- NOT carried over.`);
    console.log("    That's the L-02 fix working as intended: registrar only, going forward.");
  }

  console.log(`\n4/6 Replaying ${snapshot.merchants.length} merchant registration(s)…`);
  let registered = 0;
  for (const m of snapshot.merchants) {
    tx = await registry.registerMerchant(m.wallet, m.name, { gasLimit: 150_000 });
    await tx.wait();
    registered += 1;
    if (!m.active) {
      tx = await registry.setActive(m.wallet, false, { gasLimit: 100_000 });
      await tx.wait();
    }
    if (registered % 10 === 0) console.log(`    ${registered}/${snapshot.merchants.length}…`);
  }
  console.log(`    done. ${registered} merchant(s) registered.`);
  console.log("    NOTE: volume/paymentCount start at 0 for all of them -- see the migration plan's");
  console.log("    'What will NOT carry over automatically' section. Not backfilled here by design.");

  console.log("\n5/6 Handing registry + executor admin to the real owner…");
  tx = await registry.setManager(ownerAddr, true, { gasLimit: 100_000 });
  await tx.wait();
  tx = await registry.setManager(agentAddr, false, { gasLimit: 100_000 });
  await tx.wait();
  tx = await registry.transferOwnership(ownerAddr, { gasLimit: 100_000 });
  await tx.wait();
  console.log("    Registry ownership transferred. Deployer's manager grant revoked (registrar grant kept).");
  console.log("    PaymentExecutor's owner was already set to the real owner in its constructor -- no further action.");

  console.log("\n6/6 Verifying…");
  const finalCount = await registry.merchantCount();
  if (Number(finalCount) !== snapshot.merchants.length) {
    console.warn(`    ⚠ merchantCount() is ${finalCount}, expected ${snapshot.merchants.length} -- investigate before cutover.`);
  } else {
    console.log(`    merchantCount() matches snapshot: ${finalCount}.`);
  }

  const fs2 = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "..", `migrated-merchant-registry-${Date.now()}.json`);
  fs2.writeFileSync(outPath, JSON.stringify({
    network: hre.network.name, chainId: Number(hre.network.config.chainId),
    merchantRegistry: registryAddr, paymentExecutor: executorAddr,
    owner: ownerAddr, agent: agentAddr,
    migratedFromSnapshot: snapshotPath, merchantsReplayed: registered,
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`\n✅ Migration complete. Details written to ${outPath}`);
  console.log("\nNext steps (manual, deliberate -- not part of this script):");
  console.log(`  1. Update MONAD_MAINNET_MERCHANT_REGISTRY=${registryAddr} and`);
  console.log(`     MONAD_MAINNET_PAYMENT_EXECUTOR=${executorAddr} in Vercel, redeploy the app.`);
  console.log("  2. Grant the new executor a fresh USDC approval from the agent wallet (per-spender allowance).");
  console.log("  3. Spot-check a handful of migrated merchants' active state and volume=0 is expected/accepted.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
