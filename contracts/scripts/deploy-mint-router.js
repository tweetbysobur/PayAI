/**
 * Deploys MintRouter.
 *
 * Env:
 *   FEE_RECIPIENT   address that receives the service fee (your wallet)
 *   FEE_BPS         fee in basis points (1000 = 10%), default 1000
 *
 * Usage:
 *   FEE_RECIPIENT=0x... npx hardhat run scripts/deploy-mint-router.js --network monadTestnet
 *   FEE_RECIPIENT=0x... npx hardhat run scripts/deploy-mint-router.js --network monad
 *
 * After deploy, configure the target once the live NFT is known:
 *   router.setTarget(nftAddress, mintPriceWei)
 *   router.setMintCalldata(mintSelectorOrCalldata)
 */
const hre = require("hardhat");

async function main() {
  const feeRecipient = process.env.FEE_RECIPIENT;
  const feeBps = Number(process.env.FEE_BPS || "1000");
  if (!feeRecipient) throw new Error("Set FEE_RECIPIENT to your fee wallet address.");

  const Router = await hre.ethers.getContractFactory("MintRouter");
  const router = await Router.deploy(feeRecipient, feeBps);
  await router.waitForDeployment();
  const addr = await router.getAddress();

  console.log("MintRouter deployed:", addr);
  console.log("Network:", hre.network.name);
  console.log("Fee recipient:", feeRecipient);
  console.log("Fee bps:", feeBps);
  console.log("");
  console.log("Next: point it at the live NFT:");
  console.log(`  router.setTarget(<nftAddress>, <mintPriceWei>)`);
  console.log(`  router.setMintCalldata(<mintSelectorOrCalldata>)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
