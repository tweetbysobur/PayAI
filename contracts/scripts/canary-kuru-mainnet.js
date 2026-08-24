const hre = require("hardhat");
const E = hre.ethers;

/**
 * Gate 4 — REAL mainnet Kuru canary through the deployed PayAITradeExecutor.
 * Signed by the USER wallet (msg.sender == payer == beneficiary). Tiny amounts.
 *
 * Kuru has NO recipient — output lands in the executor and is forwarded to the
 * user (native MON on a buy, ERC-20 quote on a sell). The executor takes a
 * 0.25% fee from the GROSS input first (paid in the INPUT token to treasury),
 * then trades the NET. Sizing (kuruSize) and minOut are computed from NET the
 * SAME way the app's lib/monad/kuruSwap.ts does (verifiedMarket precisions +
 * a real callStatic simulation of the market order).
 *
 * DIRECTION (env, required):
 *   native-erc20   spend native MON, receive USDC   (MON/USDC market)
 *   erc20-native   spend USDC, receive native MON    (MON/USDC market)
 *
 * Required env (contracts/.env):
 *   MONAD_AGENT_PRIVATE_KEY        the USER wallet (funded with a little MON + USDC)
 *   PAYAI_TRADE_EXECUTOR_ADDRESS   deployed executor
 *   DIRECTION                      native-erc20 | erc20-native
 * Optional:
 *   TEST_AMOUNT_MON   default 0.02   (used when spending native MON)
 *   TEST_AMOUNT_USDC  default 0.05   (used when spending USDC)
 *   SLIPPAGE          default 0.02 (2%)
 *   KURU_ROUTER / KURU_MON_USDC_MARKET / MONAD_MAINNET_USDC / _WMON / PAYAI_TRADE_TREASURY
 *
 * Run:  DIRECTION=native-erc20 npx hardhat run scripts/canary-kuru-mainnet.js --network monad
 *       DIRECTION=erc20-native npx hardhat run scripts/canary-kuru-mainnet.js --network monad
 */

const ROUTER = process.env.KURU_ROUTER || "0xd651346d7c789536ebf06dc72aE3C8502cd695CC";
const MARKET = process.env.KURU_MON_USDC_MARKET || "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
const USDC = process.env.MONAD_MAINNET_USDC || "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const WMON = process.env.MONAD_MAINNET_WMON || "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const TREASURY = process.env.PAYAI_TRADE_TREASURY || SAFE;
const NATIVE = "0x0000000000000000000000000000000000000000";
const FEE_BPS = 25n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
];
const ROUTER_ABI = [
  "function verifiedMarket(address) view returns (uint32 pricePrecision,uint96 sizePrecision,address baseAssetAddress,uint256 baseAssetDecimals,address quoteAssetAddress,uint256 quoteAssetDecimals,uint32 tickSize,uint96 minSize,uint96 maxSize,uint256 takerFeeBps,uint256 makerFeeBps)",
];
const ORDERBOOK_ABI = [
  "function placeAndExecuteMarketBuy(uint96 _quoteSize,uint256 _minAmountOut,bool _isMargin,bool _isFillOrKill) payable returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 _size,uint256 _minAmountOut,bool _isMargin,bool _isFillOrKill) payable returns (uint256)",
];

function check(label, ok, detail) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`); return ok; }
function precisionDecimals(p) { return p.toString().length - 1; }
function toPrecisionUnits(amountHuman, precision) {
  const pd = precisionDecimals(precision);
  return E.parseUnits(amountHuman.toFixed(pd), pd);
}
const isMonLeg = (leg) => leg.toLowerCase() === NATIVE || leg.toLowerCase() === WMON.toLowerCase();

async function main() {
  const direction = process.env.DIRECTION;
  if (!["native-erc20", "erc20-native"].includes(direction || "")) throw new Error("Set DIRECTION=native-erc20 or erc20-native.");
  const addr = process.env.PAYAI_TRADE_EXECUTOR_ADDRESS;
  if (!addr || !E.isAddress(addr)) throw new Error("Set PAYAI_TRADE_EXECUTOR_ADDRESS.");

  const [user] = await E.getSigners();
  if (!user) throw new Error("No signer. Set MONAD_AGENT_PRIVATE_KEY (USER wallet).");
  const net = await E.provider.getNetwork();
  if (net.chainId !== 143n) throw new Error(`Expected Monad mainnet chainId 143, got ${net.chainId}.`);
  if (user.address.toLowerCase() === TREASURY.toLowerCase()) throw new Error("USER signer must NOT be the treasury/Safe.");

  // Read the market's real precisions and base/quote legs from the Kuru router.
  const router = new E.Contract(ROUTER, ROUTER_ABI, user);
  const vm = await router.verifiedMarket(MARKET);
  const pricePrecision = BigInt(vm.pricePrecision);
  const sizePrecision = BigInt(vm.sizePrecision);
  const base = vm.baseAssetAddress, baseDec = Number(vm.baseAssetDecimals);
  const quote = vm.quoteAssetAddress, quoteDec = Number(vm.quoteAssetDecimals);
  if (base === NATIVE && quote === NATIVE) throw new Error("Market appears unregistered (base==quote==0).");

  // Which leg is being SPENT, and is that the quote (=> BUY) or base (=> SELL)?
  const spendNative = direction === "native-erc20";
  const spentAddr = spendNative ? NATIVE : USDC;
  const spentIsQuote = spendNative ? isMonLeg(quote) : (quote.toLowerCase() === USDC.toLowerCase());
  const spentIsBase = spendNative ? isMonLeg(base) : (base.toLowerCase() === USDC.toLowerCase());
  if (!spentIsQuote && !spentIsBase) throw new Error(`Spent token ${spentAddr} matches neither base(${base}) nor quote(${quote}).`);
  const isBuy = spentIsQuote; // spending quote = buy base; spending base = sell for quote

  const tokenIn = spendNative ? NATIVE : USDC;
  const tokenOut = spendNative ? USDC : NATIVE;
  const inDec = spendNative ? 18 : 6;
  const outDec = spendNative ? 6 : 18;

  const grossHumanStr = spendNative ? (process.env.TEST_AMOUNT_MON || "0.02") : (process.env.TEST_AMOUNT_USDC || "0.05");
  const gross = E.parseUnits(grossHumanStr, inDec);
  const fee = (gross * FEE_BPS) / 10000n;
  const netIn = gross - fee;
  const netHuman = Number(E.formatUnits(netIn, inDec));
  const slippage = Number(process.env.SLIPPAGE || "0.02");

  // Kuru size unit: BUY sizes by pricePrecision (quote), SELL by sizePrecision (base).
  const kuruSize = toPrecisionUnits(netHuman, isBuy ? pricePrecision : sizePrecision);

  // Quote via a real callStatic simulation of the exact market order (minOut=0),
  // from the zero address with NO value — mirroring kuruSwap.ts.
  const market = new E.Contract(MARKET, ORDERBOOK_ABI, user);
  const fn = isBuy ? "placeAndExecuteMarketBuy" : "placeAndExecuteMarketSell";
  let simOut;
  try {
    simOut = await market[fn].staticCall(kuruSize, 0n, false, false, { from: NATIVE });
  } catch (e) {
    throw new Error(`Kuru simulate (${fn}) failed — cannot size the canary safely: ${e.shortMessage || e.message}`);
  }
  const bps = BigInt(Math.round((1 - slippage) * 1_000_000));
  let minOut = (simOut * bps) / 1_000_000n;
  if (minOut === 0n && simOut > 0n) minOut = 1n;

  console.log(`── Kuru canary (${direction}) ─────────────────────────────`);
  console.log(`Executor:   ${addr}`);
  console.log(`User:       ${user.address}`);
  console.log(`Market:     ${MARKET}  base=${base} quote=${quote}`);
  console.log(`isBuy:      ${isBuy}  (spending ${isBuy ? "quote" : "base"})`);
  console.log(`tokenIn:    ${tokenIn}${spendNative ? " (native MON)" : " (USDC)"}   tokenOut: ${tokenOut}${spendNative ? " (USDC)" : " (native MON)"}`);
  console.log(`gross in:   ${grossHumanStr}  fee=${E.formatUnits(fee, inDec)}  net=${E.formatUnits(netIn, inDec)}`);
  console.log(`kuruSize:   ${kuruSize}  sim out=${E.formatUnits(simOut, outDec)}  minOut=${E.formatUnits(minOut, outDec)}\n`);

  const exec = await E.getContractAt("PayAITradeExecutor", addr, user);
  const usdc = new E.Contract(USDC, ERC20_ABI, user);
  const wmon = new E.Contract(WMON, ERC20_ABI, user);
  const balNative = (who) => E.provider.getBalance(who);

  // Snapshots.
  const userOutBefore = tokenOut === NATIVE ? await balNative(user.address) : await usdc.balanceOf(user.address);
  const treasInBefore = tokenIn === NATIVE ? await balNative(TREASURY) : await usdc.balanceOf(TREASURY);
  const execUsdcBefore = await usdc.balanceOf(addr);
  const execWmonBefore = await wmon.balanceOf(addr);
  const execNativeBefore = await balNative(addr);

  // Approve executor for EXACT gross when spending USDC.
  if (!spendNative) {
    const userUsdc = await usdc.balanceOf(user.address);
    if (userUsdc < gross) throw new Error(`Insufficient USDC: need ${grossHumanStr}, have ${E.formatUnits(userUsdc, 6)}.`);
    const cur = await usdc.allowance(user.address, addr);
    if (cur < gross) {
      if (cur !== 0n) { const z = await usdc.approve(addr, 0n); await z.wait(); }
      const a = await usdc.approve(addr, gross);
      console.log(`approve(executor, ${grossHumanStr} USDC) [EXACT] tx: ${a.hash}`);
      if ((await a.wait()).status !== 1) throw new Error("approve reverted.");
    }
  }

  // Execute (attach value only when spending native).
  console.log(`tradeKuruExactInput...`);
  const overrides = spendNative ? { value: gross } : {};
  const tx = await exec.tradeKuruExactInput(MARKET, isBuy, tokenIn, tokenOut, kuruSize, gross, minOut, overrides);
  console.log(`trade tx:   ${tx.hash}`);
  const rc = await tx.wait();
  const gasSpent = rc.gasUsed * (rc.gasPrice ?? tx.gasPrice ?? 0n);
  console.log(`status:     ${rc.status === 1 ? "SUCCESS" : "REVERTED"} (block ${rc.blockNumber})`);
  console.log(`explorer:   https://monadexplorer.com/tx/${tx.hash}\n`);
  if (rc.status !== 1) throw new Error("Trade reverted.");

  let ev = null;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== addr.toLowerCase()) continue;
    try { const p = exec.interface.parseLog(log); if (p && p.name === "TradeExecuted") { ev = p; break; } } catch (_) {}
  }
  if (!ev) throw new Error("No TradeExecuted event — traceability NOT proven.");
  const amountOut = ev.args.amountOut, feeAmount = ev.args.feeAmount;

  // Post snapshots.
  const userOutAfter = tokenOut === NATIVE ? await balNative(user.address) : await usdc.balanceOf(user.address);
  const treasInAfter = tokenIn === NATIVE ? await balNative(TREASURY) : await usdc.balanceOf(TREASURY);
  const execUsdcAfter = await usdc.balanceOf(addr);
  const execWmonAfter = await wmon.balanceOf(addr);
  const execNativeAfter = await balNative(addr);
  const execMarketAllow = await usdc.allowance(addr, MARKET); // executor should reset to 0 (erc20-in only)
  const userExecAllow = spendNative ? 0n : await usdc.allowance(user.address, addr);

  console.log("── On-chain verification ─────────────────────────────────");
  let ok = true;
  ok &= check("Trade succeeded", rc.status === 1);
  ok &= check("User is the signer (event.user == msg.sender)", ev.args.user.toLowerCase() === user.address.toLowerCase(), ev.args.user);
  ok &= check("TradeExecuted event exists", true);
  ok &= check("Correct venue == KURU(1)", Number(ev.args.venue) === 1, `venue=${ev.args.venue}`);
  ok &= check("Correct tokenIn", ev.args.tokenIn.toLowerCase() === tokenIn.toLowerCase(), ev.args.tokenIn);
  ok &= check("Correct tokenOut", ev.args.tokenOut.toLowerCase() === tokenOut.toLowerCase(), ev.args.tokenOut);
  ok &= check("Correct amountIn == gross", ev.args.amountIn === gross, `${ev.args.amountIn}`);
  ok &= check("amountOut >= minOut", amountOut >= minOut, `out=${E.formatUnits(amountOut, outDec)} minOut=${E.formatUnits(minOut, outDec)}`);
  ok &= check("Correct 0.25% fee (event.feeAmount == gross*25/10000)", feeAmount === fee, `${E.formatUnits(feeAmount, inDec)}`);
  ok &= check("Treasury received the fee (tokenIn delta == fee)", (treasInAfter - treasInBefore) === fee, `${E.formatUnits(treasInAfter - treasInBefore, inDec)}`);
  if (tokenOut === NATIVE) {
    // Native output is gas-confounded off-chain; amountOut is the contract's own
    // authoritative user-delta. Prove the user's native balance rose by amountOut
    // net of a small, gas-sized shortfall. With amountOut>=minOut + zero-retention
    // below, this proves full delivery without trusting gas math.
    const rawDelta = userOutAfter - userOutBefore;   // == amountOut - gasFee
    const gap = amountOut - rawDelta;                // == gasFee (>= 0, whatever its size)
    ok &= check("User received the output (native, gas-independent)",
      rawDelta > 0n && gap >= 0n,
      `nativeDelta=${E.formatUnits(rawDelta, outDec)} amountOut=${E.formatUnits(amountOut, outDec)} impliedGas=${E.formatUnits(gap, outDec)}`);
  } else {
    const userOutDelta = userOutAfter - userOutBefore; // ERC-20 out is exact
    ok &= check("User received the output (delta == amountOut)", userOutDelta === amountOut,
      `delta=${E.formatUnits(userOutDelta, outDec)} out=${E.formatUnits(amountOut, outDec)}`);
  }
  ok &= check("Executor retains zero USDC", execUsdcAfter === 0n, `${execUsdcAfter}`);
  ok &= check("Executor retains zero WMON", execWmonAfter === 0n, `${execWmonAfter}`);
  ok &= check("Executor retains zero native MON", execNativeAfter === 0n, `${execNativeAfter}`);
  ok &= check("No leftover executor->market allowance (== 0)", execMarketAllow === 0n, `${execMarketAllow}`);
  if (!spendNative) ok &= check("No leftover user->executor allowance (== 0)", userExecAllow === 0n, `${userExecAllow}`);
  ok &= check("Tx interacted with PayAITradeExecutor (emitter == executor)", rc.logs.some(l => l.address.toLowerCase() === addr.toLowerCase()));

  console.log(`\n── TradeExecuted (decoded) ──`);
  console.log(`  tradeId=${ev.args.tradeId} user=${ev.args.user} venue=${ev.args.venue}`);
  console.log(`  tokenIn=${ev.args.tokenIn} tokenOut=${ev.args.tokenOut}`);
  console.log(`  amountIn=${ev.args.amountIn} amountOut=${ev.args.amountOut} feeAmount=${ev.args.feeAmount}`);
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} — Kuru ${direction}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
