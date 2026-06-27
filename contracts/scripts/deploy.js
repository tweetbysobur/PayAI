const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployer account. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env first.",
    );
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:   ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer:  ", deployer.address);
  console.log("Balance:   ", hre.ethers.formatEther(balance), "MON");

  if (balance === 0n) {
    throw new Error(
      `Deployer ${deployer.address} has 0 MON. Fund it from the Monad faucet, then retry.`,
    );
  }

  console.log("\nDeploying VeriPayRegistry…");
  const factory = await hre.ethers.getContractFactory("VeriPayRegistry");
  // Explicit gasLimit so we skip eth_estimateGas (free RPCs often cap it).
  const contract = await factory.deploy({ gasLimit: 1_500_000 });
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\n✅ Deployed VeriPayRegistry at:", address);
  console.log("\nAdd this to VeriPAYai .env.local (and Vercel env):");
  console.log(`MONAD_REGISTRY_ADDRESS=${address}`);

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed.json"),
    JSON.stringify(
      {
        contract: "VeriPayRegistry",
        network: hre.network.name,
        chainId: Number(hre.network.config.chainId),
        address,
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log("\n📝 Saved to contracts/deployed.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
