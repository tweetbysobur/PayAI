const hre = require("hardhat");

/**
 * Deploys ONLY the new SplitSettlement contract — PayAI's user-signed,
 * no-custody primitive for atomically splitting a payment across up to 10
 * recipients in one transaction (see contracts/SplitSettlement.sol and the
 * Phase 4A/4B/4C reports). It holds no funds between calls, has no agent role,
 * no fee, no treasury, and no arbitrary-call surface; the constructor takes
 * just an admin `owner` (pause + ownership transfer only — can never move
 * user funds).
 *
 * This deploys the new contract and NOTHING else. It does NOT touch any other
 * contract, change any env var / Vercel config, or wire the app to it — SDK
 * integration is a separate, later phase (Phase 5) and only after this
 * deployment is verified live.
 *
 * Owner is the PayAI Safe multisig FROM BLOCK ZERO — there is no deployer-EOA
 * owner window. On mainnet this script REFUSES to deploy if the resolved owner
 * equals the deployer (a §21 hard requirement), so a fresh deploy can never
 * accidentally leave an EOA in control even for one block.
 *
 * Usage (the audited path is mainnet-first per Phase 4C):
 *   npx hardhat run scripts/deploy-split-settlement.js --network monad
 * A testnet dry-run (if desired) is the same script against monadTestnet.
 *
 * Required env (contracts/.env):
 *   MONAD_AGENT_PRIVATE_KEY — a funded deployer key for the target network.
 * Optional:
 *   SPLIT_SETTLEMENT_OWNER  — admin owner. Defaults to the PayAI Safe below.
 *                             On mainnet it MUST be a multisig, never the EOA.
 */

// The PayAI Safe multisig — the same admin owner every other live PayAI
// contract uses (see contracts/LIVE_CONTRACTS.md, verified on-chain via each
// contract's own owner() getter). Owner power is pause + ownership-transfer
// only; it can never move user funds.
const PAYAI_SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const owner = process.env.SPLIT_SETTLEMENT_OWNER || PAYAI_SAFE;
  if (!hre.ethers.isAddress(owner)) throw new Error(`SPLIT_SETTLEMENT_OWNER is not a valid address: ${owner}`);

  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const isMainnet = chainId === 143;
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("── Pre-flight ────────────────────────────────────────────");
  console.log(`Network:   ${hre.network.name} (chainId ${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Balance:   ${hre.ethers.formatEther(balance)} MON`);
  console.log(`Owner:     ${owner} (admin — pause + ownership only, cannot move funds)`);

  if (balance === 0n) throw new Error(`Deployer ${deployer.address} has 0 MON — fund it first.`);

  // §21: on mainnet the deployer EOA must NEVER be the (even temporary) owner.
  if (isMainnet && owner.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error(
      "REFUSING: on mainnet the owner must be the PayAI Safe multisig, not the deployer EOA. " +
        "Set SPLIT_SETTLEMENT_OWNER to the Safe (or leave it unset to use the built-in Safe address).",
    );
  }
  if (!isMainnet && owner.toLowerCase() === deployer.address.toLowerCase()) {
    console.log("NOTE: owner == deployer (an EOA). Acceptable only for a testnet dry-run.");
  }

  console.log("\nDeploying SplitSettlement…");
  const Factory = await hre.ethers.getContractFactory("SplitSettlement");
  const contract = await Factory.deploy(owner);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const deployTx = contract.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;

  // Read back the on-chain state immediately, from the contract itself.
  const onOwner = await contract.owner();
  const onPaused = await contract.paused();
  const onCount = await contract.settlementCount();
  const onMax = await contract.MAX_RECIPIENTS();

  console.log("\n── Deployed ──────────────────────────────────────────────");
  console.log(`SplitSettlement: ${address}`);
  console.log(`Deploy tx:       ${deployTx ? deployTx.hash : "(unknown)"}`);
  console.log(`Block:           ${receipt ? receipt.blockNumber : "(unknown)"}`);
  console.log(`owner():         ${onOwner}  ${onOwner.toLowerCase() === owner.toLowerCase() ? "✓ Safe" : "✗ MISMATCH"}`);
  console.log(`paused():        ${onPaused}  ${onPaused === false ? "✓" : "✗"}`);
  console.log(`settlementCount: ${onCount}  ${onCount === 0n ? "✓" : "✗"}`);
  console.log(`MAX_RECIPIENTS:  ${onMax}  ${onMax === 10n ? "✓" : "✗"}`);

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-split-settlement.json"),
    JSON.stringify(
      {
        contract: "SplitSettlement",
        network: hre.network.name,
        chainId,
        address,
        owner: onOwner,
        deployer: deployer.address,
        deployTx: deployTx ? deployTx.hash : null,
        block: receipt ? receipt.blockNumber : null,
        auditedCommit: "4520723",
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log("\n📝 Saved to contracts/deployed-split-settlement.json");

  console.log("\nNext steps (manual, NOT done by this script):");
  console.log("  1. Verify source on Monad Sourcify: npx hardhat verify --network monad " + address + " " + owner);
  console.log("  2. Confirm owner()==Safe, paused()==false, settlementCount()==0, MAX_RECIPIENTS()==10 on the explorer.");
  console.log("  3. Native smoke test: one splitPayment of a tiny MON amount to 2 controlled recipients.");
  console.log("  4. Record the address in contracts/LIVE_CONTRACTS.md — never before it is verified live.");
  console.log("  5. SDK integration (Phase 5) only after all of the above succeed.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
