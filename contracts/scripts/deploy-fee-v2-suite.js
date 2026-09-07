const hre = require("hardhat");

/**
 * Deploys PayAIForwarderV2, PaymentExecutorV2, and AutomationVaultV2 — the
 * three fee-enabled contracts extending PayAI's 0.25% service fee (already
 * live on trading via PayAITradeExecutor/V2) to Send Payment, Wallet
 * Automation, and Reserved Funds. See contracts/contracts/*V2.sol for the
 * full design and contracts/test/*V2.test.js for the 49-test proof.
 *
 * This deploys the three new contracts and NOTHING else. It deliberately
 * does NOT:
 *   - Touch PayAIForwarder (V1), PaymentExecutor (V1), AutomationVault (V1),
 *     MerchantRegistry, or PayAITradeExecutor/V2 — none are modified,
 *     redeployed, or paused. All keep working exactly as before.
 *   - Authorize PaymentExecutorV2 as a MerchantRegistry recorder — that's an
 *     onlyOwner call on MerchantRegistry, owned by the cold wallet
 *     (0x8EED2...364F), which the deployer/agent key here cannot sign. See
 *     the printed instructions at the end.
 *   - Change any env var, Vercel config, or cut the app over. New
 *     automations/payments keep using the live V1 contracts until
 *     MONAD_MAINNET_PAYAI_FORWARDER / MONAD_MAINNET_PAYMENT_EXECUTOR /
 *     MONAD_MAINNET_AUTOMATION_VAULT are deliberately repointed — a
 *     separate, later step. Existing automations are pinned to their
 *     original contracts (executorAddress/vaultAddress) regardless.
 *
 * Owner split (read directly from the live contracts before writing this
 * script, not from memory or docs):
 *   - PayAIForwarderV2 owner    = the PayAI Safe (matches live Forwarder V1)
 *   - PaymentExecutorV2 owner   = the cold EOA wallet (matches live V1)
 *   - AutomationVaultV2 owner   = the cold EOA wallet (matches live V1)
 *   - treasury (all three)      = the PayAI Safe (matches PayAITradeExecutor's
 *                                 treasury exactly — one shared revenue
 *                                 destination across every fee-collecting
 *                                 PayAI contract, regardless of which
 *                                 contract family's admin role differs)
 *
 * PaymentExecutorV2's remaining constructor args (registry, caps) are read
 * live from the current PaymentExecutor (0xf723BE80...508AF) immediately
 * before deploying, not hardcoded, so this script can never silently drift
 * from whatever the real production caps are at run time.
 *
 * Required env (contracts/.env):
 *   MONAD_AGENT_PRIVATE_KEY — the same agent/deployer key used for every
 *                             prior mainnet deploy in this suite.
 * Optional overrides (defaults are the confirmed live values):
 *   PAYAI_SAFE            default 0xA282833B52b1B66D58bD2007081dCC037798C0b0
 *   PAYAI_COLD_OWNER      default 0x8EED298C65887bB53a61E28c19a7252b9DC2364F
 *   PAYAI_FEE_BPS         default 25 (= 0.25%)
 *
 * Run (mainnet):
 *   npx hardhat run scripts/deploy-fee-v2-suite.js --network monad
 */

const SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const COLD_OWNER = "0x8EED298C65887bB53a61E28c19a7252b9DC2364F";
const AGENT = "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a";
const LIVE_MERCHANT_REGISTRY = "0xadf04A50a2319D8B57245Db2aEB101DAb517AA72";
const LIVE_PAYMENT_EXECUTOR_V1 = "0xf723BE809A99A1c29e0205a542aa2aEF80B508AF";
const LIVE_AUTOMATION_VAULT_V1 = "0x87D42314d1BAf2386fB9ff3dF398b543bc64cA47";
const LIVE_FORWARDER_V1 = "0x4ce7B3036595eDA699Aebeb47b34fd4bc4F80709";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");
  if (deployer.address.toLowerCase() !== AGENT.toLowerCase()) {
    throw new Error(`MONAD_AGENT_PRIVATE_KEY resolves to ${deployer.address}, expected the known agent ${AGENT}.`);
  }

  const safe = process.env.PAYAI_SAFE || SAFE;
  const coldOwner = process.env.PAYAI_COLD_OWNER || COLD_OWNER;
  const feeBps = Number(process.env.PAYAI_FEE_BPS || "25");
  if (!(feeBps >= 0 && feeBps <= 100)) throw new Error(`feeBps out of range (0..100): ${feeBps}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:  ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer: ", deployer.address);
  console.log("Balance:  ", hre.ethers.formatEther(balance), "MON");
  console.log("Safe (Forwarder owner + treasury for all three):", safe);
  console.log("Cold EOA (PaymentExecutorV2/AutomationVaultV2 owner):", coldOwner);
  console.log("feeBps:   ", feeBps, `(${(feeBps / 100).toFixed(2)}%)`);
  if (balance === 0n) throw new Error(`Deployer has 0 MON. Fund ${deployer.address}.`);

  // Read the LIVE PaymentExecutor's current caps so V2 starts with the exact
  // same limits, never a stale hardcoded guess.
  const V1_ABI = [
    "function dailyCap() view returns (uint256)",
    "function maxTxAmount() view returns (uint256)",
    "function dailyCapNative() view returns (uint256)",
    "function maxTxAmountNative() view returns (uint256)",
    "function merchantRegistry() view returns (address)",
    "function owner() view returns (address)",
  ];
  const v1Executor = new hre.ethers.Contract(LIVE_PAYMENT_EXECUTOR_V1, V1_ABI, hre.ethers.provider);
  const [dailyCap, maxTxAmount, dailyCapNative, maxTxAmountNative, registryOnChain, v1ExecutorOwner] = await Promise.all([
    v1Executor.dailyCap(),
    v1Executor.maxTxAmount(),
    v1Executor.dailyCapNative(),
    v1Executor.maxTxAmountNative(),
    v1Executor.merchantRegistry(),
    v1Executor.owner(),
  ]);
  if (registryOnChain.toLowerCase() !== LIVE_MERCHANT_REGISTRY.toLowerCase()) {
    throw new Error(`Live PaymentExecutor's merchantRegistry() (${registryOnChain}) does not match the expected ${LIVE_MERCHANT_REGISTRY} — aborting rather than deploying against a stale assumption.`);
  }
  if (v1ExecutorOwner.toLowerCase() !== coldOwner.toLowerCase()) {
    throw new Error(`Live PaymentExecutor's owner() (${v1ExecutorOwner}) does not match the expected cold owner ${coldOwner} — aborting.`);
  }
  console.log("\nRead live PaymentExecutor caps (matching V2 to production exactly):");
  console.log("    dailyCap:         ", dailyCap.toString());
  console.log("    maxTxAmount:      ", maxTxAmount.toString());
  console.log("    dailyCapNative:   ", dailyCapNative.toString());
  console.log("    maxTxAmountNative:", maxTxAmountNative.toString());

  // Same live-owner cross-check for AutomationVault and Forwarder before touching them.
  const V1_OWNER_ABI = ["function owner() view returns (address)"];
  const v1Vault = new hre.ethers.Contract(LIVE_AUTOMATION_VAULT_V1, V1_OWNER_ABI, hre.ethers.provider);
  const v1VaultOwner = await v1Vault.owner();
  if (v1VaultOwner.toLowerCase() !== coldOwner.toLowerCase()) {
    throw new Error(`Live AutomationVault's owner() (${v1VaultOwner}) does not match the expected cold owner ${coldOwner} — aborting.`);
  }
  const v1Forwarder = new hre.ethers.Contract(LIVE_FORWARDER_V1, V1_OWNER_ABI, hre.ethers.provider);
  const v1ForwarderOwner = await v1Forwarder.owner();
  if (v1ForwarderOwner.toLowerCase() !== safe.toLowerCase()) {
    throw new Error(`Live PayAIForwarder's owner() (${v1ForwarderOwner}) does not match the expected Safe ${safe} — aborting.`);
  }
  console.log("Cross-checked: live V1 owners match this script's assumptions exactly.\n");

  console.log("1/3 Deploying PayAIForwarderV2 (owner = Safe, treasury = Safe)…");
  const Forwarder = await hre.ethers.getContractFactory("PayAIForwarderV2");
  const forwarder = await Forwarder.deploy(safe, safe, feeBps, { gasLimit: 2_500_000 });
  await forwarder.waitForDeployment();
  const forwarderAddr = await forwarder.getAddress();
  console.log("    PayAIForwarderV2 deployed:", forwarderAddr);

  console.log("\n2/3 Deploying PaymentExecutorV2 (owner = cold EOA, treasury = Safe)…");
  const Executor = await hre.ethers.getContractFactory("PaymentExecutorV2");
  const executor = await Executor.deploy(
    LIVE_MERCHANT_REGISTRY, dailyCap, coldOwner, AGENT, maxTxAmount, dailyCapNative, maxTxAmountNative, safe, feeBps,
    { gasLimit: 4_000_000 },
  );
  await executor.waitForDeployment();
  const executorAddr = await executor.getAddress();
  console.log("    PaymentExecutorV2 deployed:", executorAddr);

  console.log("\n3/3 Deploying AutomationVaultV2 (owner = cold EOA, treasury = Safe)…");
  const Vault = await hre.ethers.getContractFactory("AutomationVaultV2");
  const vault = await Vault.deploy(coldOwner, AGENT, safe, feeBps, { gasLimit: 2_000_000 });
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("    AutomationVaultV2 deployed:", vaultAddr);

  console.log("\n✅ All three deployed. V1 contracts (Forwarder/Executor/Vault) are completely untouched and still live.");

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-fee-v2-suite.json"),
    JSON.stringify(
      {
        network: hre.network.name,
        chainId: Number(hre.network.config.chainId),
        payAIForwarderV2: forwarderAddr,
        paymentExecutorV2: executorAddr,
        automationVaultV2: vaultAddr,
        forwarderOwner: safe,
        executorOwner: coldOwner,
        vaultOwner: coldOwner,
        treasury: safe,
        feeBps,
        merchantRegistry: LIVE_MERCHANT_REGISTRY,
        dailyCap: dailyCap.toString(),
        maxTxAmount: maxTxAmount.toString(),
        dailyCapNative: dailyCapNative.toString(),
        maxTxAmountNative: maxTxAmountNative.toString(),
        agent: AGENT,
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        note: "Adds the 0.25% PayAI fee (already live on trading) to Send Payment, Wallet Automation, and Reserved Funds. V1 contracts untouched.",
      },
      null,
      2,
    ),
  );
  console.log("📝 Saved to contracts/deployed-fee-v2-suite.json");

  console.log("\n" + "=".repeat(78));
  console.log("REQUIRED MANUAL STEPS BEFORE THESE CONTRACTS CAN PROCESS ANY PAYMENT");
  console.log("=".repeat(78));
  console.log(`
1. Authorize the new executor to record merchant volume — THIS MUST BE SIGNED
   BY THE COLD OWNER WALLET (${coldOwner}), not the agent key used to deploy:

     MerchantRegistry(${LIVE_MERCHANT_REGISTRY}).setRecorder(${executorAddr}, true)

2. PayAIForwarderV2 and AutomationVaultV2 need NO registry authorization —
   their constructors already set the correct owner/agent/treasury directly,
   so they are immediately usable for their respective operations once
   deployed (Forwarder: interactive payments; Vault: reserve/release/refund).

3. Only when you're ready for the actual cutover: update the app's env vars
   in Vercel —
     MONAD_MAINNET_PAYAI_FORWARDER=${forwarderAddr}
     MONAD_MAINNET_PAYMENT_EXECUTOR=${executorAddr}
     MONAD_MAINNET_AUTOMATION_VAULT=${vaultAddr}
     PAYAI_TREASURY_ADDRESS=${safe}
     PAYAI_FEE_SEND_PAYMENT_BPS=${feeBps}
     PAYAI_FEE_WALLET_AUTOMATION_BPS=${feeBps}
     PAYAI_FEE_RESERVED_FUNDS_BPS=${feeBps}
   then redeploy the app. Do this as a deliberate, separate action. Because
   every automation created before this cutover has its own
   executorAddress/vaultAddress pinned, this ONLY affects payments/
   automations created after it — nothing existing breaks or starts being
   charged a fee it wasn't created expecting.

4. The OLD Forwarder (${LIVE_FORWARDER_V1}), OLD executor (${LIVE_PAYMENT_EXECUTOR_V1}),
   and OLD vault (${LIVE_AUTOMATION_VAULT_V1}) keep working the entire time,
   before, during, and after this — nothing about this script or the steps
   above affects them.
`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
