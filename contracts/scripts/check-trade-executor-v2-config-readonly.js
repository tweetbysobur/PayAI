const hre = require("hardhat");

/**
 * Gate 8 — READ-ONLY verification of a deployed PayAITradeExecutorV2's
 * config. Signs nothing, sends nothing. Reads every on-chain parameter and
 * prints a PASS/FAIL against the confirmed Gate 8 expectation. Mirrors
 * scripts/check-trade-executor-config-readonly.js (Gate 4), extended with
 * the two Nad.Fun router allowlist checks V1 never had.
 *
 * Required env:
 *   PAYAI_TRADE_EXECUTOR_V2_ADDRESS  — the deployed V2 contract address.
 * Optional (defaults are the confirmed Gate 8 set):
 *   PAYAI_TRADE_OWNER    0xA282833B52b1B66D58bD2007081dCC037798C0b0 (Safe)
 *   PAYAI_TRADE_TREASURY 0xA282833B52b1B66D58bD2007081dCC037798C0b0 (Safe)
 *   PAYAI_TRADE_FEE_BPS  25
 *   MONAD_MAINNET_UNISWAP_ROUTER 0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900
 *   MONAD_MAINNET_WMON          0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
 *   KURU_MON_USDC_MARKET        0x065C9d28E428A0db40191a54d33d5b7c71a9C394
 *   MONAD_MAINNET_NADFUN_BONDING_CURVE_ROUTER 0x6F6B8F1a20703309951a5127c45B49b1CD981A22
 *   MONAD_MAINNET_NADFUN_DEX_ROUTER            0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137
 *
 * Run:  PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> \
 *         npx hardhat run scripts/check-trade-executor-v2-config-readonly.js --network monad
 */

const SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";

async function main() {
  const addr = process.env.PAYAI_TRADE_EXECUTOR_V2_ADDRESS;
  if (!addr || !hre.ethers.isAddress(addr)) throw new Error("Set PAYAI_TRADE_EXECUTOR_V2_ADDRESS to the deployed V2 address.");

  const owner = (process.env.PAYAI_TRADE_OWNER || SAFE).toLowerCase();
  const treasury = (process.env.PAYAI_TRADE_TREASURY || SAFE).toLowerCase();
  const feeBps = Number(process.env.PAYAI_TRADE_FEE_BPS || "25");
  const uniswapRouter = (process.env.MONAD_MAINNET_UNISWAP_ROUTER || "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900").toLowerCase();
  const wmon = (process.env.MONAD_MAINNET_WMON || "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A").toLowerCase();
  const kuruMonUsdc = (process.env.KURU_MON_USDC_MARKET || "0x065C9d28E428A0db40191a54d33d5b7c71a9C394").toLowerCase();
  const bondingCurveRouter = (process.env.MONAD_MAINNET_NADFUN_BONDING_CURVE_ROUTER || "0x6F6B8F1a20703309951a5127c45B49b1CD981A22").toLowerCase();
  const dexRouter = (process.env.MONAD_MAINNET_NADFUN_DEX_ROUTER || "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137").toLowerCase();

  const net = await hre.ethers.provider.getNetwork();
  if (net.chainId !== 143n) throw new Error(`Expected Monad mainnet chainId 143, got ${net.chainId}.`);

  const exec = await hre.ethers.getContractAt("PayAITradeExecutorV2", addr);

  const onOwner = (await exec.owner()).toLowerCase();
  const onTreasury = (await exec.treasury()).toLowerCase();
  const onFee = Number(await exec.feeBps());
  const onPaused = await exec.paused();
  const onRouter = (await exec.uniswapRouter()).toLowerCase();
  const onWmon = (await exec.wmon()).toLowerCase();
  const onMaxFee = Number(await exec.MAX_FEE_BPS());
  const monUsdcAllowed = await exec.allowedKuruMarket(kuruMonUsdc);
  const bondingAllowed = await exec.allowedNadFunRouter(bondingCurveRouter);
  const dexAllowed = await exec.allowedNadFunRouter(dexRouter);

  const rows = [
    ["owner() == PayAI Safe", onOwner, owner, onOwner === owner],
    ["treasury() == Safe", onTreasury, treasury, onTreasury === treasury],
    ["feeBps() == 25 (0.25%)", onFee, feeBps, onFee === feeBps],
    ["paused() == false", onPaused, false, onPaused === false],
    ["uniswapRouter()", onRouter, uniswapRouter, onRouter === uniswapRouter],
    ["wmon()", onWmon, wmon, onWmon === wmon],
    ["MAX_FEE_BPS() == 100", onMaxFee, 100, onMaxFee === 100],
    ["Kuru MON/USDC allowlisted", monUsdcAllowed, true, monUsdcAllowed === true],
    ["Nad.Fun BondingCurveRouter allowlisted", bondingAllowed, true, bondingAllowed === true],
    ["Nad.Fun DexRouter allowlisted", dexAllowed, true, dexAllowed === true],
  ];

  console.log(`PayAITradeExecutorV2: ${addr}`);
  console.log(`Explorer:             https://monadexplorer.com/address/${addr}\n`);
  let allPass = true;
  for (const [label, got, want, ok] of rows) {
    if (!ok) allPass = false;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        got=${got}  want=${want}`);
  }
  console.log(`\nNOTE: the Kuru + Nad.Fun allowlist lines are FALSE until the Safe seeds them`);
  console.log(`      (setKuruMarket / setNadFunRouter — see the Gate 8 runbook, Steps 4-5).`);
  console.log(`\nRESULT: ${allPass ? "ALL PASS" : "one or more checks FAILED — do not proceed"}`);
  if (!allPass) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
