const hre = require("hardhat");

/**
 * Deploys the VeriPAY on-chain execution suite to Monad:
 *   1. MerchantRegistry
 *   2. PaymentExecutor(registry)
 *   3. registry.setRecorder(executor, true)  — let the executor accrue volume
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:  ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer: ", deployer.address);
  console.log("Balance:  ", hre.ethers.formatEther(balance), "MON");
  if (balance === 0n) throw new Error(`Deployer has 0 MON. Fund ${deployer.address} from the faucet.`);

  console.log("\n1/3 Deploying MerchantRegistry…");
  const Registry = await hre.ethers.getContractFactory("MerchantRegistry");
  const registry = await Registry.deploy({ gasLimit: 1_500_000 });
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("    MerchantRegistry:", registryAddr);

  console.log("\n2/3 Deploying PaymentExecutor…");
  // Per-agent daily spend cap in token base units (6dp). Default 1,000 USDC;
  // set DAILY_CAP=0 for unlimited. Defense-in-depth beyond the app guardrails.
  const DAILY_CAP = BigInt(process.env.DAILY_CAP ?? "1000000000"); // 1,000 * 1e6
  console.log("    dailyCap:", DAILY_CAP.toString(), "base units");
  const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
  const executor = await Executor.deploy(registryAddr, DAILY_CAP, { gasLimit: 2_800_000 });
  await executor.waitForDeployment();
  const executorAddr = await executor.getAddress();
  console.log("    PaymentExecutor: ", executorAddr);

  console.log("\n3/3 Authorizing executor as registry recorder…");
  const tx = await registry.setRecorder(executorAddr, true, { gasLimit: 200_000 });
  await tx.wait();
  console.log("    done.");

  console.log("\n✅ Suite deployed. Add to VeriPAYai .env.local (and Vercel env):");
  console.log(`MONAD_MERCHANT_REGISTRY=${registryAddr}`);
  console.log(`MONAD_PAYMENT_EXECUTOR=${executorAddr}`);

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-suite.json"),
    JSON.stringify(
      {
        network: hre.network.name,
        chainId: Number(hre.network.config.chainId),
        merchantRegistry: registryAddr,
        paymentExecutor: executorAddr,
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log("\n📝 Saved to contracts/deployed-suite.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
