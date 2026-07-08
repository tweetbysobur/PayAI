const hre = require("hardhat");

/**
 * Fresh full-suite deploy (Path B) — new MerchantRegistry + new PaymentExecutor
 * with decimals-aware native-MON spend limits set at deploy time.
 *
 * Why "fresh": the previous suite's admin (cold owner) key is unrecoverable,
 * so its registry can never authorize a new executor as a recorder. Rather
 * than depend on that lost key, we redeploy both contracts under a NEW cold
 * owner the user controls — and crucially, authorize the executor as the
 * registry's recorder DURING deploy (while the deployer still owns the fresh
 * registry), so NO post-deploy cold-wallet action is required for payments to
 * work. Ownership is then handed to the new cold wallet for future admin only.
 *
 * The deployer (agent hot key, already on the machine) pays gas and performs
 * the one-time wiring; it holds no lasting admin power once ownership transfers.
 *
 * Required env:
 *   MONAD_AGENT_PRIVATE_KEY   — deployer/agent key (pays gas, becomes the executor's agent).
 *   NEW_COLD_OWNER_ADDRESS    — the freshly-created cold wallet's PUBLIC address.
 * Optional:
 *   DAILY_CAP                 (USDC base units, 6dp)     default 1,000 USDC
 *   MAX_TX_AMOUNT             (USDC base units, 6dp)     default 100 USDC
 *   DAILY_CAP_NATIVE_MON      (whole MON → wei)          default 2,000,000
 *   MAX_TX_AMOUNT_NATIVE_MON  (whole MON → wei)          default 1,000,000
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const ownerAddr = process.env.NEW_COLD_OWNER_ADDRESS;
  const agentAddr = deployer.address; // the hot key IS the agent
  if (!ownerAddr) throw new Error("Set NEW_COLD_OWNER_ADDRESS — the freshly-created cold wallet's public address.");
  if (ownerAddr.toLowerCase() === agentAddr.toLowerCase()) {
    throw new Error("NEW_COLD_OWNER_ADDRESS must differ from the agent/deployer address (0x25b8…dc3a).");
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:  ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer/Agent:", deployer.address, "(pays gas, becomes executor agent)");
  console.log("New Owner: ", ownerAddr, "(fresh cold wallet — admin only)");
  console.log("Balance:  ", hre.ethers.formatEther(balance), "MON");
  if (balance === 0n) throw new Error(`Deployer has 0 MON. Fund ${deployer.address}.`);

  const DAILY_CAP = BigInt(process.env.DAILY_CAP ?? "1000000000"); // 1,000 USDC
  const MAX_TX_AMOUNT = BigInt(process.env.MAX_TX_AMOUNT ?? "100000000"); // 100 USDC
  const DAILY_CAP_NATIVE = hre.ethers.parseEther(process.env.DAILY_CAP_NATIVE_MON ?? "2000000");
  const MAX_TX_AMOUNT_NATIVE = hre.ethers.parseEther(process.env.MAX_TX_AMOUNT_NATIVE_MON ?? "1000000");

  console.log("\n1/4 Deploying MerchantRegistry…");
  const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
  const registry = await Registry.deploy({ gasLimit: 1_500_000 });
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("    MerchantRegistry:", registryAddr);

  console.log("\n2/4 Deploying PaymentExecutor (native caps set at deploy)…");
  console.log("    maxTxAmountNative:", hre.ethers.formatEther(MAX_TX_AMOUNT_NATIVE), "MON");
  console.log("    dailyCapNative:   ", hre.ethers.formatEther(DAILY_CAP_NATIVE), "MON");
  const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
  const executor = await Executor.deploy(
    registryAddr,
    DAILY_CAP,
    ownerAddr,
    agentAddr,
    DAILY_CAP_NATIVE,
    MAX_TX_AMOUNT_NATIVE,
    { gasLimit: 3_500_000 },
  );
  await executor.waitForDeployment();
  const executorAddr = await executor.getAddress();
  console.log("    PaymentExecutor: ", executorAddr);

  // Authorize the executor as recorder NOW, while the deployer still owns the
  // registry — this is what removes any need for a post-deploy owner call.
  console.log("\n3/4 Authorizing executor as registry recorder (deployer-signed)…");
  let tx = await registry.setRecorder(executorAddr, true, { gasLimit: 200_000 });
  await tx.wait();
  console.log("    done.");

  console.log("\n4/4 Handing registry ownership to the new cold wallet…");
  tx = await registry.setManager(ownerAddr, true, { gasLimit: 100_000 });
  await tx.wait();
  tx = await registry.transferOwnership(ownerAddr, { gasLimit: 100_000 });
  await tx.wait();
  console.log("    done.");

  console.log("\n✅ Fresh suite deployed and fully wired — no cold-wallet action required.");
  console.log("\nSend me these two addresses and I'll update Vercel + redeploy the app:");
  console.log(`MONAD_MAINNET_MERCHANT_REGISTRY=${registryAddr}`);
  console.log(`MONAD_MAINNET_PAYMENT_EXECUTOR=${executorAddr}`);
  console.log("\n(Optional, later, from the new cold wallet only — sets the USDC per-tx cap;");
  console.log(` native MON caps are already live. PaymentExecutor.setMaxTxAmount(${MAX_TX_AMOUNT}).)`);

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-suite-v3-fresh.json"),
    JSON.stringify(
      {
        network: hre.network.name,
        chainId: Number(hre.network.config.chainId),
        merchantRegistry: registryAddr,
        paymentExecutor: executorAddr,
        owner: ownerAddr,
        agent: agentAddr,
        dailyCap: DAILY_CAP.toString(),
        maxTxAmount: MAX_TX_AMOUNT.toString(),
        dailyCapNative: DAILY_CAP_NATIVE.toString(),
        maxTxAmountNative: MAX_TX_AMOUNT_NATIVE.toString(),
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log("\n📝 Saved to contracts/deployed-suite-v3-fresh.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
