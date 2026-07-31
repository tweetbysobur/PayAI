const hre = require("hardhat");

/**
 * Redeploys PaymentExecutor + AutomationVault ONLY, carrying the Ultrafuzz
 * M-02 fix (balanceOf-delta verification against fee-on-transfer / short-
 * delivering ERC-20 tokens — see contracts/contracts/PaymentExecutor.sol's
 * INVARIANT-PE-8 and AutomationVault.sol's INVARIANT-AV-7). Nothing else
 * changes:
 *
 *   - Reuses the EXISTING MerchantRegistry (0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb)
 *     — every already-onboarded merchant stays registered with zero extra steps.
 *   - Same owner, same agent, same daily/per-tx caps (USDC + native MON) as
 *     the currently live executor (contracts/deployed-payment-executor-v4.json)
 *     and the currently live vault (contracts/deployed-suite-v3-fresh.json).
 *
 * This script deploys the two new contracts ONLY. It deliberately does NOT:
 *   - Call registry.setRecorder() for the new executor — that's `onlyOwner`
 *     on MerchantRegistry, and ownership was handed to the cold wallet
 *     (0x8eed…364f). The deployer/agent hot key here cannot sign that call.
 *     See the printed instructions at the end.
 *   - Touch env vars, Vercel, or cut the app over to either new address.
 *     Per the app's Phase 0 per-automation address pinning
 *     (lib/platform/types.ts PaymentAutomation.executorAddress/vaultAddress),
 *     switching MONAD_MAINNET_PAYMENT_EXECUTOR / MONAD_MAINNET_AUTOMATION_VAULT
 *     only affects automations created AFTER the cutover — that's a
 *     separate, deliberate Phase 3 action, not automatic here.
 *   - Grant the agent's fresh USDC approval to the new executor — also
 *     printed as a manual next step.
 *
 * AutomationVault needs NO post-deploy authorization call at all (its
 * constructor takes only owner/agent — no MerchantRegistry dependency), so
 * it is immediately usable once deployed; only the executor needs the
 * cold-wallet setRecorder step below.
 *
 * The OLD PaymentExecutor (0x824050B7ef424a730779f676EA6863f908d82991) and
 * OLD AutomationVault (0x1b84c9Aa7E46b90d6e49422e1Cf18142AAD3FE0f) are
 * completely unaffected by running this — they keep working exactly as
 * before, independent of whatever gets deployed here, until and unless the
 * app's env vars are deliberately switched over.
 *
 * Required env:
 *   MONAD_AGENT_PRIVATE_KEY  — the SAME agent hot key already in use today
 *                              (deployer here == agent, matching the live
 *                              deployment's role split).
 * Optional overrides (defaults match the live deployment exactly):
 *   DAILY_CAP, MAX_TX_AMOUNT                       (USDC base units, 6dp)
 *   DAILY_CAP_NATIVE_MON, MAX_TX_AMOUNT_NATIVE_MON  (whole MON)
 */

const EXISTING_MERCHANT_REGISTRY = "0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb";
const EXISTING_OWNER = "0x8eed298c65887bb53a61e28c19a7252b9dc2364f";
const EXISTING_AGENT = "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a";
const OLD_EXECUTOR = "0x824050B7ef424a730779f676EA6863f908d82991";
const OLD_VAULT = "0x1b84c9Aa7E46b90d6e49422e1Cf18142AAD3FE0f";

// Matches contracts/deployed-payment-executor-v4.json exactly.
const DEFAULT_DAILY_CAP = "2000000000000"; // 2,000,000 USDC (6dp)
const DEFAULT_MAX_TX_AMOUNT = "1000000000000"; // 1,000,000 USDC (6dp)
const DEFAULT_DAILY_CAP_NATIVE_MON = "2000000";
const DEFAULT_MAX_TX_AMOUNT_NATIVE_MON = "1000000";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  if (deployer.address.toLowerCase() !== EXISTING_AGENT.toLowerCase()) {
    throw new Error(
      `MONAD_AGENT_PRIVATE_KEY resolves to ${deployer.address}, but the live deployment's agent is ${EXISTING_AGENT}. ` +
        "Use the same agent key so the new contracts' role split matches the live one — or update EXISTING_AGENT " +
        "in this script if you deliberately intend to rotate the agent key too.",
    );
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:        ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("Deployer/Agent: ", deployer.address, "(same agent as the live deployment)");
  console.log("Owner (unchanged):", EXISTING_OWNER);
  console.log("MerchantRegistry (reused, unchanged):", EXISTING_MERCHANT_REGISTRY);
  console.log("Balance:        ", hre.ethers.formatEther(balance), "MON");
  if (balance === 0n) throw new Error(`Deployer has 0 MON. Fund ${deployer.address}.`);

  const DAILY_CAP = BigInt(process.env.DAILY_CAP ?? DEFAULT_DAILY_CAP);
  const MAX_TX_AMOUNT = BigInt(process.env.MAX_TX_AMOUNT ?? DEFAULT_MAX_TX_AMOUNT);
  const DAILY_CAP_NATIVE = hre.ethers.parseEther(process.env.DAILY_CAP_NATIVE_MON ?? DEFAULT_DAILY_CAP_NATIVE_MON);
  const MAX_TX_AMOUNT_NATIVE = hre.ethers.parseEther(
    process.env.MAX_TX_AMOUNT_NATIVE_MON ?? DEFAULT_MAX_TX_AMOUNT_NATIVE_MON,
  );

  console.log("\n1/2 Deploying patched PaymentExecutor (Ultrafuzz M-02 fix)…");
  console.log("    maxTxAmount (USDC): ", (Number(MAX_TX_AMOUNT) / 1e6).toLocaleString(), "USDC");
  console.log("    dailyCap (USDC):    ", (Number(DAILY_CAP) / 1e6).toLocaleString(), "USDC");
  console.log("    maxTxAmountNative:  ", hre.ethers.formatEther(MAX_TX_AMOUNT_NATIVE), "MON");
  console.log("    dailyCapNative:     ", hre.ethers.formatEther(DAILY_CAP_NATIVE), "MON");

  const Executor = await hre.ethers.getContractFactory("PaymentExecutor");
  const executor = await Executor.deploy(
    EXISTING_MERCHANT_REGISTRY,
    DAILY_CAP,
    EXISTING_OWNER,
    EXISTING_AGENT,
    MAX_TX_AMOUNT,
    DAILY_CAP_NATIVE,
    MAX_TX_AMOUNT_NATIVE,
    { gasLimit: 3_500_000 },
  );
  await executor.waitForDeployment();
  const executorAddr = await executor.getAddress();
  console.log("    PaymentExecutor deployed:", executorAddr);

  console.log("\n2/2 Deploying patched AutomationVault (Ultrafuzz M-02 fix)…");
  const Vault = await hre.ethers.getContractFactory("AutomationVault");
  const vault = await Vault.deploy(EXISTING_OWNER, EXISTING_AGENT, { gasLimit: 1_800_000 });
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("    AutomationVault deployed:", vaultAddr);

  console.log("\n✅ Both new contracts deployed.");
  console.log(`   OLD executor (${OLD_EXECUTOR}) is untouched and still live.`);
  console.log(`   OLD vault    (${OLD_VAULT}) is untouched and still live.`);

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-suite-v4-ultrafuzz.json"),
    JSON.stringify(
      {
        network: hre.network.name,
        chainId: Number(hre.network.config.chainId),
        merchantRegistry: EXISTING_MERCHANT_REGISTRY,
        paymentExecutor: executorAddr,
        automationVault: vaultAddr,
        owner: EXISTING_OWNER,
        agent: EXISTING_AGENT,
        dailyCap: DAILY_CAP.toString(),
        maxTxAmount: MAX_TX_AMOUNT.toString(),
        dailyCapNative: DAILY_CAP_NATIVE.toString(),
        maxTxAmountNative: MAX_TX_AMOUNT_NATIVE.toString(),
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        note: "Carries the Ultrafuzz M-02 balanceOf-delta fix on both contracts. Old executor/vault left untouched.",
      },
      null,
      2,
    ),
  );
  console.log("📝 Saved to contracts/deployed-suite-v4-ultrafuzz.json");

  console.log("\n" + "=".repeat(78));
  console.log("REQUIRED MANUAL STEPS BEFORE THESE CONTRACTS CAN PROCESS ANY PAYMENT");
  console.log("=".repeat(78));
  console.log(`
1. Authorize the new executor to record merchant volume — THIS MUST BE SIGNED
   BY THE COLD OWNER WALLET (${EXISTING_OWNER}), not the agent key used to
   deploy. Call, from the cold wallet:

     MerchantRegistry(${EXISTING_MERCHANT_REGISTRY}).setRecorder(${executorAddr}, true)

   Do this via the cold wallet's own signing method (hardware wallet, Safe,
   or a wallet UI's "Write Contract" tab on the block explorer) — never
   paste that wallet's key anywhere, including into this tool.

2. AutomationVault needs NO registry authorization — its constructor already
   set owner=${EXISTING_OWNER}, agent=${EXISTING_AGENT} directly, so it is
   immediately usable for reserve/release/refund once deployed.

3. Grant the agent a fresh USDC approval to the NEW executor address. The
   agent's existing approval was given to the OLD executor and does not
   carry over (ERC-20 approvals are per-spender-address). Without this,
   executePayment on the new contract will fail with "transfer failed"
   even though everything else is wired correctly.

4. Only after 1 and 3 are confirmed on-chain, and only when you're ready for
   Phase 3 of the redeploy plan: update the app's
   MONAD_MAINNET_PAYMENT_EXECUTOR to ${executorAddr} and
   MONAD_MAINNET_AUTOMATION_VAULT to ${vaultAddr}, then redeploy the app.
   Do this as a deliberate, separate action — not automatically as part of
   this script. Because every automation created before this cutover has its
   own executorAddress/vaultAddress pinned (Phase 0), this cutover ONLY
   affects automations created after it — nothing existing breaks.

5. The OLD executor (${OLD_EXECUTOR}) and OLD vault (${OLD_VAULT}) keep
   working the entire time, before, during, and after this — nothing about
   this script or the steps above affects them.
`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
