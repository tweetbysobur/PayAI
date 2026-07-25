const hre = require("hardhat");

/**
 * Redeploys ONLY PaymentExecutor, carrying the merchant-registration gate
 * fix (executePaymentFrom now requires the destination be a registered,
 * active merchant in MerchantRegistry — see the "fix: scope the merchant-
 * registration gate to executePaymentFrom only" commit for the full
 * rationale). Nothing else changes:
 *
 *   - Reuses the EXISTING MerchantRegistry (0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb)
 *     — no reason to redeploy it, and reusing it means every already-onboarded
 *     merchant stays registered with zero extra steps.
 *   - Same owner, same agent, same daily/per-tx caps (USDC + native MON) as
 *     the currently live suite (contracts/deployed-suite-v3-fresh.json).
 *
 * This script deploys the new contract ONLY. It deliberately does NOT:
 *   - Call registry.setRecorder() for the new executor — that's `onlyOwner`
 *     on MerchantRegistry, and ownership was handed to the cold wallet
 *     (0x8eed…364f) in the last deploy. The deployer/agent hot key here
 *     cannot sign that call. See the printed instructions at the end.
 *   - Touch env vars, Vercel, or cut the app over to the new address.
 *   - Grant the agent's fresh USDC approval to the new contract — also
 *     printed as a manual next step (though this one CAN be signed by the
 *     agent hot key if you choose to automate it later).
 *
 * The OLD PaymentExecutor (0xCB847C0B15798233b8a18CE926eD8b6E4Cd1D873) is
 * completely unaffected by running this — it keeps working exactly as
 * before, independent of whatever gets deployed here, until and unless the
 * app's env var is deliberately switched over.
 *
 * Required env:
 *   MONAD_AGENT_PRIVATE_KEY  — the SAME agent hot key already in use today
 *                              (deployer here == agent, matching the live
 *                              deployment's role split).
 * Optional overrides (defaults match the live deployment exactly):
 *   DAILY_CAP, MAX_TX_AMOUNT              (USDC base units, 6dp)
 *   DAILY_CAP_NATIVE_MON, MAX_TX_AMOUNT_NATIVE_MON  (whole MON)
 */

const EXISTING_MERCHANT_REGISTRY = "0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb";
const EXISTING_OWNER = "0x8eed298c65887bb53a61e28c19a7252b9dc2364f";
const EXISTING_AGENT = "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a";

// Matches contracts/deployed-suite-v3-fresh.json exactly.
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
        "Use the same agent key so the new contract's role split matches the live one — or update EXISTING_AGENT " +
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

  console.log("\nDeploying patched PaymentExecutor…");
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
  console.log("\n✅ New PaymentExecutor deployed:", executorAddr);
  console.log("   The OLD executor (0xCB847C0B15798233b8a18CE926eD8b6E4Cd1D873) is untouched and still live.");

  const fs = require("fs");
  const path = require("path");
  fs.writeFileSync(
    path.join(__dirname, "..", "deployed-payment-executor-v4.json"),
    JSON.stringify(
      {
        network: hre.network.name,
        chainId: Number(hre.network.config.chainId),
        merchantRegistry: EXISTING_MERCHANT_REGISTRY,
        paymentExecutor: executorAddr,
        owner: EXISTING_OWNER,
        agent: EXISTING_AGENT,
        dailyCap: DAILY_CAP.toString(),
        maxTxAmount: MAX_TX_AMOUNT.toString(),
        dailyCapNative: DAILY_CAP_NATIVE.toString(),
        maxTxAmountNative: MAX_TX_AMOUNT_NATIVE.toString(),
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        note: "Carries the executePaymentFrom merchant-registration gate fix. Old executor (0xCB847C0B...) left untouched.",
      },
      null,
      2,
    ),
  );
  console.log("📝 Saved to contracts/deployed-payment-executor-v4.json");

  console.log("\n" + "=".repeat(78));
  console.log("REQUIRED MANUAL STEPS BEFORE THIS CONTRACT CAN PROCESS ANY PAYMENT");
  console.log("=".repeat(78));
  console.log(`
1. Authorize the new executor to record merchant volume — THIS MUST BE SIGNED
   BY THE COLD OWNER WALLET (${EXISTING_OWNER}), not the agent key used to
   deploy. Call, from the cold wallet:

     MerchantRegistry(${EXISTING_MERCHANT_REGISTRY}).setRecorder(${executorAddr}, true)

   Do this via the cold wallet's own signing method (hardware wallet, Safe,
   or a wallet UI's "Write Contract" tab on the block explorer) — never
   paste that wallet's key anywhere, including into this tool.

2. Grant the agent a fresh USDC approval to the NEW executor address. The
   agent's existing approval was given to the OLD executor and does not
   carry over (ERC-20 approvals are per-spender-address). Without this,
   executePayment on the new contract will fail with "transfer failed"
   even though everything else is wired correctly.

3. Only after 1 and 2 are confirmed on-chain: update the app's
   MONAD_MAINNET_PAYMENT_EXECUTOR env var to ${executorAddr} and redeploy
   the app. Do this as a deliberate, separate action — not automatically
   as part of this script.

4. The OLD executor (0xCB847C0B15798233b8a18CE926eD8b6E4Cd1D873) keeps
   working the entire time, before, during, and after this — nothing
   about this script or the steps above affects it.
`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
