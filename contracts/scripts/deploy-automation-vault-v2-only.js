const hre = require("hardhat");

/**
 * Retry-only script for AutomationVaultV2, after the combined
 * deploy-fee-v2-suite.js run's first two deploys (PayAIForwarderV2,
 * PaymentExecutorV2) succeeded but the vault deploy ran out of gas at a
 * 2,000,000 gas limit (gasUsed == gasLimit exactly, status 0 — a plain
 * out-of-gas, not a logic revert). Raises the limit; touches nothing else.
 */
const SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const COLD_OWNER = "0x8EED298C65887bB53a61E28c19a7252b9DC2364F";
const AGENT = "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a";
const FEE_BPS = 25;
// From the partial run's console output — that run errored before it could
// write deployed-fee-v2-suite.json, so these two are recorded here instead
// of re-deploying them (which would waste gas creating unwanted duplicates).
const FORWARDER_V2 = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const EXECUTOR_V2 = "0x5cAf11937aCbaaFd774c3906a5086A7507fae84D";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (deployer.address.toLowerCase() !== AGENT.toLowerCase()) {
    throw new Error(`Unexpected deployer ${deployer.address}, expected ${AGENT}`);
  }
  console.log("Deploying AutomationVaultV2 (owner = cold EOA, treasury = Safe) with a higher gas limit…");
  const Vault = await hre.ethers.getContractFactory("AutomationVaultV2");
  const vault = await Vault.deploy(COLD_OWNER, AGENT, SAFE, FEE_BPS, { gasLimit: 3_500_000 });
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("AutomationVaultV2 deployed:", vaultAddr);

  const fs = require("fs");
  const path = require("path");
  const record = {
    network: hre.network.name,
    chainId: Number(hre.network.config.chainId),
    payAIForwarderV2: FORWARDER_V2,
    paymentExecutorV2: EXECUTOR_V2,
    automationVaultV2: vaultAddr,
    forwarderOwner: SAFE,
    executorOwner: COLD_OWNER,
    vaultOwner: COLD_OWNER,
    treasury: SAFE,
    feeBps: FEE_BPS,
    merchantRegistry: "0xadf04A50a2319D8B57245Db2aEB101DAb517AA72",
    agent: AGENT,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    note: "Adds the 0.25% PayAI fee (already live on trading) to Send Payment, Wallet Automation, and Reserved Funds. V1 contracts untouched. Forwarder+Executor deployed in the first (partial) run of deploy-fee-v2-suite.js; Vault deployed by this retry script after the first attempt's vault deploy ran out of gas at a 2,000,000 limit.",
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployed-fee-v2-suite.json"), JSON.stringify(record, null, 2));
  console.log("📝 Wrote contracts/deployed-fee-v2-suite.json with all three addresses.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
