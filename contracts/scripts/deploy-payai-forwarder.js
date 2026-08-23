const hre = require("hardhat");

/**
 * Deploys ONLY the new PayAIForwarder — the on-chain footprint for
 * interactive, user-signed payments (see contracts/PayAIForwarder.sol and the
 * Step 8.1 report). It holds no funds, has no agent role, and cannot move any
 * user's money; the constructor takes just an admin `owner` (pause + ownership
 * transfer only).
 *
 * This deploys the new contract and NOTHING else. It deliberately does NOT:
 *   - Touch PaymentExecutor, AutomationVault, MerchantRegistry, VeriPayRegistry,
 *     or any trading contract — all of those are unaffected.
 *   - Change any env var, Vercel config, or cut the app over. The app keeps
 *     using the existing direct-transfer path until MONAD_MAINNET_PAYAI_FORWARDER
 *     (mainnet) / MONAD_TESTNET_PAYAI_FORWARDER (testnet) is set AND the
 *     feature flag is enabled — see lib/monad/config.ts's getPayAIForwarder().
 *
 * Deploy to TESTNET FIRST:
 *   npx hardhat run scripts/deploy-payai-forwarder.js --network monadTestnet
 *
 * Required env (contracts/.env):
 *   MONAD_AGENT_PRIVATE_KEY  — a funded deployer key for the target network.
 * Optional:
 *   PAYAI_FORWARDER_OWNER    — the admin owner address (cold wallet / multisig).
 *                              Defaults to the deployer if unset (fine for a
 *                              testnet dry-run; on mainnet, pass a real multisig).
 */

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const owner = process.env.PAYAI_FORWARDER_OWNER || deployer.address;
  if (!hre.ethers.isAddress(owner)) throw new Error(`PAYAI_FORWARDER_OWNER is not a valid address: ${owner}`);

  const net = await hre.ethers.provider.getNetwork();
  console.log(`Network: chainId ${net.chainId}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Owner (admin — pause + ownership only, cannot move funds): ${owner}`);
  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    console.log("NOTE: owner == deployer (an EOA). Fine for testnet; use a multisig for mainnet.");
  }

  const Forwarder = await hre.ethers.getContractFactory("PayAIForwarder");
  const forwarder = await Forwarder.deploy(owner);
  await forwarder.waitForDeployment();
  const address = await forwarder.getAddress();
  const deployTx = forwarder.deploymentTransaction();

  console.log("\n── Deployed ──────────────────────────────────────────────");
  console.log(`PayAIForwarder: ${address}`);
  console.log(`Deploy tx:      ${deployTx ? deployTx.hash : "(unknown)"}`);
  console.log("\nNext steps (manual, not done here):");
  console.log("  1. Verify source on the Monad Sourcify verifier.");
  console.log("  2. Make one real native-MON payment and one real ERC-20 payment through it.");
  console.log("  3. Inspect both on the explorer: From=user, To=PayAIForwarder, event PaymentForwarded.");
  console.log("  4. ONLY THEN set MONAD_TESTNET_PAYAI_FORWARDER and enable the feature flag.");
  console.log("  5. Record the address in contracts/LIVE_CONTRACTS.md — never before it is verified live.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
