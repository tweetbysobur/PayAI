const hre = require("hardhat");

/**
 * Deploys PaymentExecutor v3 — adds decimals-aware native-MON spend limits
 * (dailyCapNative/maxTxAmountNative), fixing a bug where the ERC-20 caps
 * (sized for USDC's 6 decimals) were reused verbatim against 18-decimal
 * native MON wei, causing ordinary MON automation payments to revert with
 * "exceeds max tx amount".
 *
 * Reuses the EXISTING MerchantRegistry (no merchant re-registration needed) —
 * only PaymentExecutor is redeployed.
 *
 * Required env:
 *   MONAD_AGENT_PRIVATE_KEY        — deployer key (pays gas only, no role
 *                                    unless also passed as AGENT_ADDRESS).
 *   COLD_OWNER_ADDRESS             — cold wallet / multisig. Admin only.
 *   AGENT_ADDRESS                  — dedicated hot wallet the app signs with.
 *   EXISTING_MERCHANT_REGISTRY     — the already-deployed MerchantRegistry
 *                                    to reuse.
 * Optional:
 *   DAILY_CAP           (base units, 6dp for USDC)   default 1,000 USDC
 *   MAX_TX_AMOUNT       (base units, 6dp for USDC)    default 100 USDC
 *   DAILY_CAP_NATIVE_MON   (whole MON, converted to wei)  default 2,000,000
 *   MAX_TX_AMOUNT_NATIVE_MON (whole MON, converted to wei) default 1,000,000
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const ownerAddr = process.env.COLD_OWNER_ADDRESS;
  const agentAddr = process.env.AGENT_ADDRESS;
  const registryAddr = process.env.EXISTING_MERCHANT_REGISTRY;
  if (!ownerAddr) throw new Error("Set COLD_OWNER_ADDRESS — a cold wallet/multisig, never a server key.");
  if (!agentAddr) throw new Error("Set AGENT_ADDRESS — the dedicated hot wallet the app signs with.");
  if (!registryAddr) throw new Error("Set EXISTING_MERCHANT_REGISTRY — reuse the already-deployed registry.");
  if (ownerAddr.toLowerCase() === agentAddr.toLowerCase()) {
    throw new Error("COLD_OWNER_ADDRESS and AGENT_ADDRESS must be different wallets.");
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:  ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer: ", deployer.address, "(pays gas only — no role)");
  console.log("Owner:    ", ownerAddr, "(cold wallet — admin only)");
  console.log("Agent:    ", agentAddr, "(hot wallet — execution only)");
  console.log("Registry: ", registryAddr, "(reused, not redeployed)");
  console.log("Balance:  ", hre.ethers.formatEther(balance), "MON");
  if (balance === 0n) throw new Error(`Deployer has 0 MON. Fund ${deployer.address}.`);

  const DAILY_CAP = BigInt(process.env.DAILY_CAP ?? "1000000000"); // 1,000 USDC
  const MAX_TX_AMOUNT = BigInt(process.env.MAX_TX_AMOUNT ?? "100000000"); // 100 USDC
  const DAILY_CAP_NATIVE = hre.ethers.parseEther(process.env.DAILY_CAP_NATIVE_MON ?? "2000000");
  const MAX_TX_AMOUNT_NATIVE = hre.ethers.parseEther(process.env.MAX_TX_AMOUNT_NATIVE_MON ?? "1000000");

  console.log("\nDeploying PaymentExecutor v3 (native spend limits)…");
  console.log("    dailyCap (USDC):          ", DAILY_CAP.toString(), "base units");
  console.log("    maxTxAmount (USDC):       ", MAX_TX_AMOUNT.toString(), "base units");
  console.log("    dailyCapNative (MON):     ", hre.ethers.formatEther(DAILY_CAP_NATIVE), "MON");
  console.log("    maxTxAmountNative (MON):  ", hre.ethers.formatEther(MAX_TX_AMOUNT_NATIVE), "MON");

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
  console.log("    PaymentExecutor:", executorAddr);

  console.log("\n✅ PaymentExecutor v3 deployed.");
  console.log("\nUpdate VeriPAYai .env.local (and Vercel env):");
  console.log(`MONAD_MAINNET_PAYMENT_EXECUTOR=${executorAddr}`);
  console.log("\nSTILL NEEDED — one owner-signed call from the cold wallet (never the server key):");
  console.log(`  MerchantRegistry(${registryAddr}).setRecorder(${executorAddr}, true)`);
  console.log("  (authorizes the NEW executor to record merchant volume; the old executor's");
  console.log("   authorization can be revoked afterward with setRecorder(oldExecutor, false).)");
  console.log("\n  maxTxAmount (USDC, ERC-20 path) also still needs the cold wallet's one-time call,");
  console.log(`  same as before: PaymentExecutor(${executorAddr}).setMaxTxAmount(${MAX_TX_AMOUNT})`);
  console.log("  (native caps are already set correctly at deploy time — no owner call needed for those.)");

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-suite-v3.json"),
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
  console.log("\n📝 Saved to contracts/deployed-suite-v3.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
