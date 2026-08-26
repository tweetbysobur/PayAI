const hre = require("hardhat");
const E = hre.ethers;

/**
 * Gate 8 — REAL mainnet Uniswap V3 canary through the deployed
 * PayAITradeExecutorV2. Identical logic to scripts/canary-uniswap-mainnet.js
 * (Gate 4) — kept as a separate file, targeting "PayAITradeExecutorV2" and a
 * distinct env var, so Gate 4's script and its already-used results stay
 * untouched. Signed by the USER wallet (msg.sender == payer == beneficiary;
 * the contract enforces this). Tiny amounts only.
 *
 * DIRECTION (env, required):
 *   erc20-erc20   USDC -> WMON  (tokenOut is WMON as a normal ERC-20; no unwrap)
 *   erc20-native  USDC -> MON   (tokenOut = address(0); executor unwraps WMON -> MON)
 *
 * The executor takes a 0.25% fee from the GROSS input first, then swaps the
 * NET. So the quote/minOut here are computed from NET, exactly as the contract
 * does. Fee is paid in the INPUT token (USDC) to the treasury.
 *
 * Required env (contracts/.env):
 *   MONAD_AGENT_PRIVATE_KEY          the USER wallet (funded with a little USDC + MON for gas)
 *   PAYAI_TRADE_EXECUTOR_V2_ADDRESS  deployed V2 executor
 *   DIRECTION                        erc20-erc20 | erc20-native
 * Optional:
 *   TEST_AMOUNT_USDC  default 0.02
 *   SLIPPAGE          default 0.01 (1%)
 *   MONAD_MAINNET_USDC / _WMON / _UNISWAP_QUOTER / PAYAI_TRADE_TREASURY  (address overrides)
 *
 * Run:  DIRECTION=erc20-erc20  npx hardhat run scripts/canary-uniswap-mainnet-v2.js --network monad
 *       DIRECTION=erc20-native npx hardhat run scripts/canary-uniswap-mainnet-v2.js --network monad
 */

const USDC = process.env.MONAD_MAINNET_USDC || "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const WMON = process.env.MONAD_MAINNET_WMON || "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const QUOTER = process.env.MONAD_MAINNET_UNISWAP_QUOTER || "0x661e93cca42afacb172121ef892830ca3b70f08d";
const SAFE = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const TREASURY = (process.env.PAYAI_TRADE_TREASURY || SAFE);
const NATIVE = "0x0000000000000000000000000000000000000000";
const FEE_TIERS = [500, 3000, 10000];
const FEE_BPS = 25n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];

function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  return ok;
}

async function bestQuote(quoter, tokenIn, tokenOut, amountIn) {
  let best = null;
  for (const fee of FEE_TIERS) {
    try {
      const r = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n });
      const out = r[0];
      if (out > 0n && (!best || out > best.amountOut)) best = { fee, amountOut: out };
    } catch (_) { /* pool for this tier doesn't exist -> skip */ }
  }
  if (!best) throw new Error("No Uniswap pool with liquidity across fee tiers 500/3000/10000 for this pair.");
  return best;
}

async function main() {
  const direction = process.env.DIRECTION;
  if (!["erc20-erc20", "erc20-native"].includes(direction || "")) {
    throw new Error("Set DIRECTION=erc20-erc20 or DIRECTION=erc20-native.");
  }
  const addr = process.env.PAYAI_TRADE_EXECUTOR_V2_ADDRESS;
  if (!addr || !E.isAddress(addr)) throw new Error("Set PAYAI_TRADE_EXECUTOR_V2_ADDRESS.");

  const [user] = await E.getSigners();
  if (!user) throw new Error("No signer. Set MONAD_AGENT_PRIVATE_KEY (the USER wallet).");
  const net = await E.provider.getNetwork();
  if (net.chainId !== 143n) throw new Error(`Expected Monad mainnet chainId 143, got ${net.chainId}.`);
  if (user.address.toLowerCase() === TREASURY.toLowerCase()) {
    throw new Error("The USER signer must NOT be the treasury/Safe — balance deltas would be confounded.");
  }

  const tokenInAddr = USDC;
  const tokenOutParam = direction === "erc20-native" ? NATIVE : WMON; // what we pass to the executor
  const tokenOutPool = WMON; // Uniswap pool side for the MON leg is always WMON

  const usdc = new E.Contract(USDC, ERC20_ABI, user);
  const inDec = Number(await usdc.decimals());
  const gross = E.parseUnits(process.env.TEST_AMOUNT_USDC || "0.02", inDec);
  const fee = (gross * FEE_BPS) / 10000n;
  const netIn = gross - fee;
  const slippage = Number(process.env.SLIPPAGE || "0.01");

  // Quote on NET (what the contract actually swaps), pick the best fee tier.
  const quoter = new E.Contract(QUOTER, QUOTER_ABI, user);
  const best = await bestQuote(quoter, tokenInAddr, tokenOutPool, netIn);
  const bps = BigInt(Math.round((1 - slippage) * 1_000_000));
  let minOut = (best.amountOut * bps) / 1_000_000n;
  if (minOut === 0n && best.amountOut > 0n) minOut = 1n;

  const outIsNative = direction === "erc20-native";
  const outDec = 18; // both WMON and native MON are 18-dec
  console.log(`── Uniswap V2-executor canary (${direction}) ──────────────`);
  console.log(`Executor:   ${addr}  (PayAITradeExecutorV2)`);
  console.log(`User:       ${user.address}`);
  console.log(`tokenIn:    ${tokenInAddr} (USDC, ${inDec}d)`);
  console.log(`tokenOut:   ${tokenOutParam}${outIsNative ? " (native MON)" : " (WMON, ERC-20)"}`);
  console.log(`gross in:   ${E.formatUnits(gross, inDec)} USDC`);
  console.log(`fee (0.25%):${E.formatUnits(fee, inDec)} USDC  net=${E.formatUnits(netIn, inDec)} USDC`);
  console.log(`best tier:  ${best.fee}  quote(net)=${E.formatUnits(best.amountOut, outDec)}  minOut=${E.formatUnits(minOut, outDec)}\n`);

  const exec = await E.getContractAt("PayAITradeExecutorV2", addr, user);

  // Snapshots (input token, output, treasury fee-in-tokenIn, executor retention).
  const balOf = async (t, who) => t === NATIVE ? await E.provider.getBalance(who) : await new E.Contract(t, ERC20_ABI, user).balanceOf(who);
  const userInBefore = await usdc.balanceOf(user.address);
  const userOutBefore = await balOf(tokenOutParam, user.address);
  const treasInBefore = await usdc.balanceOf(TREASURY);
  const execInBefore = await usdc.balanceOf(addr);
  const execOutBefore = outIsNative ? await E.provider.getBalance(addr) : await new E.Contract(WMON, ERC20_ABI, user).balanceOf(addr);
  const execWmonBefore = await new E.Contract(WMON, ERC20_ABI, user).balanceOf(addr);

  if (userInBefore < gross) throw new Error(`Insufficient USDC: need ${E.formatUnits(gross, inDec)}, have ${E.formatUnits(userInBefore, inDec)}.`);

  // Step 1 — approve the EXECUTOR for EXACT gross (never MAX).
  const curAllow = await usdc.allowance(user.address, addr);
  if (curAllow < gross) {
    if (curAllow !== 0n) { const z = await usdc.approve(addr, 0n); await z.wait(); }
    console.log(`approve(executor, ${E.formatUnits(gross, inDec)} USDC) [EXACT]...`);
    const a = await usdc.approve(addr, gross);
    console.log(`approve tx: ${a.hash}`);
    if ((await a.wait()).status !== 1) throw new Error("approve reverted.");
  }

  // Step 2 — the trade (deadline: now + 10 min).
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  console.log(`tradeUniswapExactInput...`);
  const tx = await exec.tradeUniswapExactInput(tokenInAddr, tokenOutParam, best.fee, gross, minOut, deadline);
  console.log(`trade tx:   ${tx.hash}`);
  const rc = await tx.wait();
  const gasSpent = rc.gasUsed * (rc.gasPrice ?? tx.gasPrice ?? 0n);
  console.log(`status:     ${rc.status === 1 ? "SUCCESS" : "REVERTED"} (block ${rc.blockNumber})`);
  console.log(`explorer:   https://monadexplorer.com/tx/${tx.hash}\n`);
  if (rc.status !== 1) throw new Error("Trade reverted.");

  // Decode TradeExecuted.
  let ev = null;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== addr.toLowerCase()) continue;
    try { const p = exec.interface.parseLog(log); if (p && p.name === "TradeExecuted") { ev = p; break; } } catch (_) {}
  }
  if (!ev) throw new Error("No TradeExecuted event — traceability NOT proven.");

  const amountOut = ev.args.amountOut;
  const feeAmount = ev.args.feeAmount;

  // Post snapshots.
  const userOutAfter = await balOf(tokenOutParam, user.address);
  const treasInAfter = await usdc.balanceOf(TREASURY);
  const execInAfter = await usdc.balanceOf(addr);
  const execOutAfter = outIsNative ? await E.provider.getBalance(addr) : await new E.Contract(WMON, ERC20_ABI, user).balanceOf(addr);
  const execWmonAfter = await new E.Contract(WMON, ERC20_ABI, user).balanceOf(addr);
  const execNativeAfter = await E.provider.getBalance(addr);
  const allowAfter = await usdc.allowance(user.address, addr);
  const ROUTER = (process.env.MONAD_MAINNET_UNISWAP_ROUTER || "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900");
  const execRouterAllow = await usdc.allowance(addr, ROUTER); // executor should reset this to 0

  console.log("── On-chain verification ─────────────────────────────────");
  let ok = true;
  ok &= check("Trade succeeded", rc.status === 1);
  ok &= check("User is the signer (event.user == msg.sender)", ev.args.user.toLowerCase() === user.address.toLowerCase(), ev.args.user);
  ok &= check("TradeExecuted event exists", true);
  ok &= check("Correct venue == UNISWAP(0)", Number(ev.args.venue) === 0, `venue=${ev.args.venue}`);
  ok &= check("Correct tokenIn", ev.args.tokenIn.toLowerCase() === tokenInAddr.toLowerCase(), ev.args.tokenIn);
  ok &= check("Correct tokenOut", ev.args.tokenOut.toLowerCase() === tokenOutParam.toLowerCase(), ev.args.tokenOut);
  ok &= check("Correct amountIn == gross", ev.args.amountIn === gross, `${ev.args.amountIn}`);
  ok &= check("amountOut >= minOut", amountOut >= minOut, `out=${E.formatUnits(amountOut, outDec)} minOut=${E.formatUnits(minOut, outDec)}`);
  ok &= check("Correct 0.25% fee (event.feeAmount == gross*25/10000)", feeAmount === fee, `${E.formatUnits(feeAmount, inDec)} USDC`);
  ok &= check("Treasury received the fee (USDC delta == fee)", (treasInAfter - treasInBefore) === fee, `${E.formatUnits(treasInAfter - treasInBefore, inDec)} USDC`);
  if (outIsNative) {
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
  ok &= check("Executor retains zero tokenIn (USDC)", execInAfter === 0n, `${execInAfter}`);
  ok &= check("Executor retains zero WMON", execWmonAfter === 0n, `${execWmonAfter}`);
  ok &= check("Executor retains zero native MON", execNativeAfter === 0n, `${execNativeAfter}`);
  ok &= check("No leftover user->executor allowance (== 0)", allowAfter === 0n, `${allowAfter}`);
  ok &= check("No leftover executor->router allowance (== 0)", execRouterAllow === 0n, `${execRouterAllow}`);
  ok &= check("Tx interacted with PayAITradeExecutorV2 (event emitter == executor)", ev.args && rc.logs.some(l => l.address.toLowerCase() === addr.toLowerCase()));

  console.log(`\n── TradeExecuted (decoded) ──`);
  console.log(`  tradeId=${ev.args.tradeId} user=${ev.args.user} venue=${ev.args.venue}`);
  console.log(`  tokenIn=${ev.args.tokenIn} tokenOut=${ev.args.tokenOut}`);
  console.log(`  amountIn=${ev.args.amountIn} amountOut=${ev.args.amountOut} feeAmount=${ev.args.feeAmount}`);
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} — Uniswap ${direction} (V2)`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
