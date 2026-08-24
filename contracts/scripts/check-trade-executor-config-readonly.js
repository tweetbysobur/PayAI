const hre = require("hardhat");

/**
 * Gate 4 — READ-ONLY verification of a deployed PayAITradeExecutor's config.
 * Signs nothing, sends nothing. Reads every on-chain parameter and prints a
 * PASS/FAIL against the confirmed Gate 4 expectation.
 *
 * Required env:
 *   PAYAI_TRADE_EXECUTOR_ADDRESS  — the deployed contract address.
 * Optional (defaults are the confirmed Gate 4 set):
 *   PAYAI_TRADE_OWNER    0xA282833B52b1B66D58bD2007081dCC037798C0b0 (Safe)
 *   PAYAI_TRADE_TREASURY 0xA282833B52b1B66D58bD2007081dCC037798C0b0 (Safe)
 *   PAYAI_TRADE_FEE_BPS  25
 *   MONAD_MAINNET_UNISWAP_ROUTER 0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900
 *   MONAD_MAINNET_WMON          0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
 *   KURU_MON_USDC_MARKET        0x065C9d28E428A0db40191a54d33d5b7c71a9C394
 *
 * Run:  npx hardhat run scripts/check-trade-executor-config-readonly.js --network monad
 */

const SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";

async function main() {
  const addr = process.env.PAYAI_TRADE_EXECUTOR_ADDRESS;
  if (!addr || !hre.ethers.isAddress(addr)) throw new Error("Set PAYAI_TRADE_EXECUTOR_ADDRESS to the deployed address.");

  const owner = (process.env.PAYAI_TRADE_OWNER || SAFE).toLowerCase();
  const treasury = (process.env.PAYAI_TRADE_TREASURY || SAFE).toLowerCase();
  const feeBps = Number(process.env.PAYAI_TRADE_FEE_BPS || "25");
  const uniswapRouter = (process.env.MONAD_MAINNET_UNISWAP_ROUTER || "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900").toLowerCase();
  const wmon = (process.env.MONAD_MAINNET_WMON || "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A").toLowerCase();
  const kuruMonUsdc = (process.env.KURU_MON_USDC_MARKET || "0x065C9d28E428A0db40191a54d33d5b7c71a9C394").toLowerCase();

  const net = await hre.ethers.provider.getNetwork();
  if (net.chainId !== 143n) throw new Error(`Expected Monad mainnet chainId 143, got ${net.chainId}.`);

  const exec = await hre.ethers.getContractAt("PayAITradeExecutor", addr);

  const onOwner = (await exec.owner()).toLowerCase();
  const onTreasury = (await exec.treasury()).toLowerCase();
  const onFee = Number(await exec.feeBps());
  const onPaused = await exec.paused();
  const onRouter = (await exec.uniswapRouter()).toLowerCase();
  const onWmon = (await exec.wmon()).toLowerCase();
  const onMaxFee = Number(await exec.MAX_FEE_BPS());
  const monUsdcAllowed = await exec.allowedKuruMarket(kuruMonUsdc);

  const rows = [
    ["owner() == PayAI Safe", onOwner, owner, onOwner === owner],
    ["treasury() == Safe", onTreasury, treasury, onTreasury === treasury],
    ["feeBps() == 25 (0.25%)", onFee, feeBps, onFee === feeBps],
    ["paused() == false", onPaused, false, onPaused === false],
    ["uniswapRouter()", onRouter, uniswapRouter, onRouter === uniswapRouter],
    ["wmon()", onWmon, wmon, onWmon === wmon],
    ["MAX_FEE_BPS() == 100", onMaxFee, 100, onMaxFee === 100],
    ["Kuru MON/USDC allowlisted", monUsdcAllowed, true, monUsdcAllowed === true],
  ];

  console.log(`PayAITradeExecutor: ${addr}`);
  console.log(`Explorer:           https://monadexplorer.com/address/${addr}\n`);
  let allPass = true;
  for (const [label, got, want, ok] of rows) {
    if (!ok) allPass = false;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        got=${got}  want=${want}`);
  }
  console.log(`\nNOTE: "Kuru MON/USDC allowlisted" is FALSE until the Safe seeds it with`);
  console.log(`      setKuruMarket(${kuruMonUsdc}, true). The two Uniswap canaries do not need it.`);
  console.log(`\nRESULT: ${allPass ? "ALL PASS" : "one or more checks FAILED — do not proceed"}`);
  if (!allPass) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
