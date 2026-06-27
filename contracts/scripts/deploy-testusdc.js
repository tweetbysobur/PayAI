const hre = require("hardhat");

/**
 * Deploys a test USDC (MockERC20, 6dp) to Monad testnet and mints a balance to
 * the agent wallet, so PaymentExecutor can move real funds end-to-end. The
 * Cleanverse aUSDC requires an A-Pass to hold; this test token lets the agent
 * demonstrate genuine on-chain settlement without that gating.
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const agent = process.env.MINT_TO || deployer.address;

  console.log("Network: ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer:", deployer.address);

  const Mock = await hre.ethers.getContractFactory("MockERC20");
  const usdc = await Mock.deploy({ gasLimit: 1_200_000 });
  await usdc.waitForDeployment();
  const addr = await usdc.getAddress();
  console.log("Test USDC:", addr);

  const amount = 1000_000000n; // 1,000 USDC (6dp)
  const tx = await usdc.mint(agent, amount, { gasLimit: 120_000 });
  await tx.wait();
  console.log(`Minted 1,000 USDC to ${agent}`);

  console.log("\nSet in VeriPAYai .env.local:");
  console.log(`MONAD_TESTNET_USDC=${addr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
