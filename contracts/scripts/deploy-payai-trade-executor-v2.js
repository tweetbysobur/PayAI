const hre = require("hardhat");

/**
 * Gate 8 — Deploys ONLY the new PayAITradeExecutorV2 (Uniswap V3 + Kuru +
 * Nad.Fun). Mirrors scripts/deploy-payai-trade-executor.js (Gate 4) exactly;
 * kept as a SEPARATE script rather than editing that one, so Gate 4's
 * already-used deploy record stays byte-for-byte intact.
 *
 * Separate, non-upgradeable, Safe-owned contract for interactive, user-signed
 * TRADES. It holds no funds after a trade, has no agent role, and cannot move
 * anyone's money: the payer/beneficiary is ALWAYS msg.sender. See
 * contracts/PayAITradeExecutorV2.sol and the Gate 7 implementation report.
 *
 * This deploys the new contract and NOTHING else. It deliberately does NOT:
 *   - Touch PayAITradeExecutor (V1, 0xF17a916280321Ddb657c8EDd26B2a729F6E63b69),
 *     PayAIForwarder, PaymentExecutor, AutomationVault, MerchantRegistry,
 *     VeriPayRegistry, or the existing direct-to-router Nad.Fun trading path.
 *   - Seed any allowlist (Kuru market or Nad.Fun router) — those are separate
 *     Safe transactions after deploy, since owner = Safe from block zero.
 *   - Change any env var, Vercel config, or cut the app over. The app keeps
 *     using its existing trading path(s) until
 *     MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2 is set AND
 *     PAYAI_TRADE_EXECUTOR_V2_ENABLED=true — neither is touched here.
 *
 * Owner is the PayAI Safe from block zero (no EOA-owner window). Because of
 * that, the deployer EOA cannot call the onlyOwner setKuruMarket/
 * setNadFunRouter afterward — every allowlist entry is seeded by a Safe
 * transaction (see the Gate 8 runbook).
 *
 * Required env (contracts/.env):
 *   MONAD_AGENT_PRIVATE_KEY  — a funded deployer key for Monad mainnet.
 * Confirmed Gate 8 parameters (env-overridable; defaults are the confirmed set,
 * identical to Gate 4's — same Safe, same fee, same Uniswap router, same WMON):
 *   PAYAI_TRADE_OWNER    default 0xA282833B52b1B66D58bD2007081dCC037798C0b0 (PayAI Safe)
 *   PAYAI_TRADE_TREASURY default 0xA282833B52b1B66D58bD2007081dCC037798C0b0 (the Safe itself)
 *   PAYAI_TRADE_FEE_BPS  default 25 (= 0.25%)
 *   MONAD_MAINNET_UNISWAP_ROUTER default 0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900 (SwapRouter02)
 *   MONAD_MAINNET_WMON          default 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A (WMON)
 *
 * Run (mainnet):
 *   npx hardhat run scripts/deploy-payai-trade-executor-v2.js --network monad
 */

const SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const V1_EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("No deployer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const owner = process.env.PAYAI_TRADE_OWNER || SAFE;
  const treasury = process.env.PAYAI_TRADE_TREASURY || SAFE;
  const feeBps = Number(process.env.PAYAI_TRADE_FEE_BPS || "25");
  const uniswapRouter = process.env.MONAD_MAINNET_UNISWAP_ROUTER || "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900";
  const wmon = process.env.MONAD_MAINNET_WMON || "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";

  for (const [k, v] of Object.entries({ owner, treasury, uniswapRouter, wmon })) {
    if (!hre.ethers.isAddress(v)) throw new Error(`${k} is not a valid address: ${v}`);
  }
  if (!(feeBps >= 0 && feeBps <= 100)) throw new Error(`feeBps out of range (0..100): ${feeBps}`);

  const net = await hre.ethers.provider.getNetwork();
  if (net.chainId !== 143n) throw new Error(`Expected Monad mainnet chainId 143, got ${net.chainId}.`);

  console.log("── Gate 8 deploy parameters (PayAITradeExecutorV2) ─────────");
  console.log(`Network:        chainId ${net.chainId} (Monad mainnet)`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`owner (Safe):   ${owner}`);
  console.log(`treasury:       ${treasury}`);
  console.log(`feeBps:         ${feeBps} (= ${(feeBps / 100).toFixed(2)}%)`);
  console.log(`uniswapRouter:  ${uniswapRouter}`);
  console.log(`wmon:           ${wmon}`);
  console.log(`Nad.Fun routers: NOT constructor params — seeded post-deploy via Safe tx`);
  console.log(`V1 executor (untouched, rollback path): ${V1_EXECUTOR}`);
  console.log("──────────────────────────────────────────────────────────");

  const Exec = await hre.ethers.getContractFactory("PayAITradeExecutorV2");
  const exec = await Exec.deploy(owner, treasury, feeBps, uniswapRouter, wmon);
  await exec.waitForDeployment();
  const address = await exec.getAddress();
  const deployTx = exec.deploymentTransaction();

  // Read the fresh on-chain config straight back, so the deploy log itself
  // records what the constructor actually set (not just what we passed).
  const onOwner = await exec.owner();
  const onTreasury = await exec.treasury();
  const onFee = await exec.feeBps();
  const onPaused = await exec.paused();
  const onRouter = await exec.uniswapRouter();
  const onWmon = await exec.wmon();

  console.log("\n── Deployed ──────────────────────────────────────────────");
  console.log(`PayAITradeExecutorV2: ${address}`);
  console.log(`Deploy tx:            ${deployTx ? deployTx.hash : "(unknown)"}`);
  console.log(`Explorer:             https://monadexplorer.com/address/${address}`);
  console.log("\n── On-chain config (read back) ───────────────────────────");
  console.log(`owner():        ${onOwner}   ${onOwner.toLowerCase() === owner.toLowerCase() ? "OK (Safe)" : "!! MISMATCH"}`);
  console.log(`treasury():     ${onTreasury}   ${onTreasury.toLowerCase() === treasury.toLowerCase() ? "OK" : "!! MISMATCH"}`);
  console.log(`feeBps():       ${onFee}   ${Number(onFee) === feeBps ? "OK" : "!! MISMATCH"}`);
  console.log(`paused():       ${onPaused}   ${onPaused === false ? "OK (not paused)" : "!! UNEXPECTED"}`);
  console.log(`uniswapRouter():${onRouter}   ${onRouter.toLowerCase() === uniswapRouter.toLowerCase() ? "OK" : "!! MISMATCH"}`);
  console.log(`wmon():         ${onWmon}   ${onWmon.toLowerCase() === wmon.toLowerCase() ? "OK" : "!! MISMATCH"}`);

  console.log("\nNext steps (manual, NOT done here):");
  console.log("  1. Verify source:  npx hardhat verify --network monad " + address +
    " " + owner + " " + treasury + " " + feeBps + " " + uniswapRouter + " " + wmon);
  console.log("  2. Read-only config check: scripts/check-trade-executor-v2-config-readonly.js");
  console.log("  3. Restore the Kuru allowlist with ONE Safe tx (setKuruMarket) — see the runbook.");
  console.log("  4. Enable the two Nad.Fun routers with Safe tx(s) (setNadFunRouter) — see the runbook.");
  console.log("  5. Run the six canary scripts (Uniswap, Kuru, Nad.Fun bonding x2, Nad.Fun DEX x2).");
  console.log("  6. Record the address in LIVE_CONTRACTS.md ONLY after everything is independently verified.");
  console.log("  7. Do NOT set MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2 or PAYAI_TRADE_EXECUTOR_V2_ENABLED yet.");
  console.log(`  V1 (${V1_EXECUTOR}) remains the production rollback path throughout.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
