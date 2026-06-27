const hre = require("hardhat");

/**
 * Deploys VeriPAY execution suite v2 — owner/agent role separation,
 * idempotent requestIds, native-MON support, and tx/merchant limits.
 *
 * Required env:
 *   MONAD_AGENT_PRIVATE_KEY   — deployer key (becomes neither owner nor agent
 *                               unless explicitly passed as one of the two
 *                               addresses below; it only pays deploy gas).
 *   COLD_OWNER_ADDRESS        — cold wallet / multisig. Admin only. NEVER put
 *                               this key on a server.
 *   AGENT_ADDRESS             — dedicated hot wallet the app signs payments
 *                               with. Execution only, zero admin power.
 * Optional:
 *   DAILY_CAP        (base units, 6dp for USDC)  default 1,000 USDC
 *   MAX_TX_AMOUNT     (base units)                default 100 USDC
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const ownerAddr = process.env.COLD_OWNER_ADDRESS;
  const agentAddr = process.env.AGENT_ADDRESS;
  if (!ownerAddr) throw new Error("Set COLD_OWNER_ADDRESS — a cold wallet/multisig, never a server key.");
  if (!agentAddr) throw new Error("Set AGENT_ADDRESS — the dedicated hot wallet the app signs with.");
  if (ownerAddr.toLowerCase() === agentAddr.toLowerCase()) {
    throw new Error("COLD_OWNER_ADDRESS and AGENT_ADDRESS must be different wallets.");
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:  ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer: ", deployer.address, "(pays gas only — no role)");
  console.log("Owner:    ", ownerAddr, "(cold wallet — admin only)");
  console.log("Agent:    ", agentAddr, "(hot wallet — execution only)");
  console.log("Balance:  ", hre.ethers.formatEther(balance), "MON");
  if (balance === 0n) throw new Error(`Deployer has 0 MON. Fund ${deployer.address}.`);

  console.log("\n1/3 Deploying MerchantRegistry…");
  const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
  const registry = await Registry.deploy({ gasLimit: 1_500_000 });
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("    MerchantRegistry:", registryAddr);

  console.log("\n2/3 Deploying PaymentExecutor (owner/agent separated)…");
  const DAILY_CAP = BigInt(process.env.DAILY_CAP ?? "1000000000"); // 1,000 USDC
  const MAX_TX_AMOUNT = BigInt(process.env.MAX_TX_AMOUNT ?? "100000000"); // 100 USDC
  console.log("    dailyCap:    ", DAILY_CAP.toString(), "base units");
  console.log("    maxTxAmount: ", MAX_TX_AMOUNT.toString(), "base units");
  const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
  const executor = await Executor.deploy(registryAddr, DAILY_CAP, ownerAddr, agentAddr, { gasLimit: 3_200_000 });
  await executor.waitForDeployment();
  const executorAddr = await executor.getAddress();
  console.log("    PaymentExecutor: ", executorAddr);

  // maxTxAmount isn't a constructor param (owner-only setter) — but the
  // deployer isn't the owner anymore, so it can't be set here. The cold
  // wallet must call setMaxTxAmount itself after deploy (see printed steps).

  // Authorize the executor as a recorder, and hand registry admin to the cold
  // wallet, BOTH while the deployer still holds owner rights — order matters,
  // ownership transfer must be last or every step after it would revert.
  console.log("\n3/4 Authorizing executor as registry recorder…");
  let tx = await registry.setRecorder(executorAddr, true, { gasLimit: 200_000 });
  await tx.wait();
  console.log("    done.");

  console.log("\n4/4 Transferring MerchantRegistry admin to cold wallet…");
  tx = await registry.setManager(ownerAddr, true, { gasLimit: 100_000 });
  await tx.wait();
  tx = await registry.transferOwnership(ownerAddr, { gasLimit: 100_000 });
  await tx.wait();
  console.log("    done.");

  console.log("\n✅ Suite v2 deployed.");
  console.log("\nAdd to VeriPAYai .env.local (and Vercel env):");
  console.log(`MONAD_MAINNET_MERCHANT_REGISTRY=${registryAddr}`);
  console.log(`MONAD_MAINNET_PAYMENT_EXECUTOR=${executorAddr}`);
  console.log(`MONAD_AGENT_PRIVATE_KEY=<the AGENT_ADDRESS private key — execution only>`);
  console.log("\nFROM THE COLD WALLET (one-time, e.g. via a hardware wallet + Etherscan-style write UI):");
  console.log(`  1. PaymentExecutor(${executorAddr}).setMaxTxAmount(${MAX_TX_AMOUNT})`);
  console.log("     (maxTxAmount can't be set at deploy time — only the owner can call it, and the");
  console.log("      deployer is intentionally not the owner.)");

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-suite-v2.json"),
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
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log("\n📝 Saved to contracts/deployed-suite-v2.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
