const hre = require("hardhat");

/**
 * Gate 4 — Deploys ONLY the new PayAITradeExecutor (Uniswap V3 + Kuru).
 *
 * Separate, non-upgradeable, Safe-owned contract for interactive, user-signed
 * TRADES. It holds no funds after a trade, has no agent role, and cannot move
 * anyone's money: the payer/beneficiary is ALWAYS msg.sender. See
 * contracts/PayAITradeExecutor.sol and the Gate 3 report.
 *
 * This deploys the new contract and NOTHING else. It deliberately does NOT:
 *   - Touch PayAIForwarder, PaymentExecutor, AutomationVault, MerchantRegistry,
 *     VeriPayRegistry, or the existing direct-to-router Nad.Fun trading path.
 *   - Include Nad.Fun in any way (no Nad.Fun router/market/logic here).
 *   - Change any env var, Vercel config, or cut the app over. The app keeps
 *     using its existing trading path until MONAD_MAINNET_PAYAI_TRADE_EXECUTOR
 *     is set AND PAYAI_TRADE_EXECUTOR_ENABLED=true — neither is touched here.
 *
 * Owner is the PayAI Safe from block zero (no EOA-owner window). Because of
 * that, the deployer EOA cannot call the onlyOwner setKuruMarket afterward —
 * the initial Kuru allowlist is seeded by ONE Safe transaction after deploy
 * (see the Gate 4 runbook). The two Uniswap canaries need no allowlist.
 *
 * Required env (contracts/.env):
 *   MONAD_AGENT_PRIVATE_KEY  — a funded deployer key for Monad mainnet.
 * Confirmed Gate 4 parameters (env-overridable; defaults are the confirmed set):
 *   PAYAI_TRADE_OWNER    default 0xA282833B52b1B66D58bD2007081dCC037798C0b0 (PayAI Safe)
 *   PAYAI_TRADE_TREASURY default 0xA282833B52b1B66D58bD2007081dCC037798C0b0 (the Safe itself)
 *   PAYAI_TRADE_FEE_BPS  default 25 (= 0.25%)
 *   MONAD_MAINNET_UNISWAP_ROUTER default 0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900 (SwapRouter02)
 *   MONAD_MAINNET_WMON          default 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A (WMON)
 *
 * Run (mainnet):
 *   npx hardhat run scripts/deploy-payai-trade-executor.js --network monad
 */

const SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";

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

  console.log("── Gate 4 deploy parameters ──────────────────────────────");
  console.log(`Network:        chainId ${net.chainId} (Monad mainnet)`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`owner (Safe):   ${owner}`);
  console.log(`treasury:       ${treasury}`);
  console.log(`feeBps:         ${feeBps} (= ${(feeBps / 100).toFixed(2)}%)`);
  console.log(`uniswapRouter:  ${uniswapRouter}`);
  console.log(`wmon:           ${wmon}`);
  console.log(`Nad.Fun:        NOT included`);
  console.log("──────────────────────────────────────────────────────────");

  const Exec = await hre.ethers.getContractFactory("PayAITradeExecutor");
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
  console.log(`PayAITradeExecutor: ${address}`);
  console.log(`Deploy tx:          ${deployTx ? deployTx.hash : "(unknown)"}`);
  console.log(`Explorer:           https://monadexplorer.com/address/${address}`);
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
  console.log("  2. Seed the Kuru allowlist with ONE Safe tx (setKuruMarket) — see the runbook.");
  console.log("  3. Run the four canary scripts (Uniswap first, then Kuru after the Safe seed).");
  console.log("  4. Record the address in LIVE_CONTRACTS.md ONLY after it is independently verified.");
  console.log("  5. Do NOT set MONAD_MAINNET_PAYAI_TRADE_EXECUTOR or PAYAI_TRADE_EXECUTOR_ENABLED yet.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
