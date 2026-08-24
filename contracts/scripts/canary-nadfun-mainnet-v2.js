const hre = require("hardhat");
const E = hre.ethers;

/**
 * Gate 8 — REAL mainnet Nad.Fun canary through the deployed
 * PayAITradeExecutorV2. New for Gate 8 — Nad.Fun was never executor-routed
 * before V2 (V1 has no tradeNadFunExactInput at all), so there is no Gate 4
 * precedent script to mirror here; this follows the same verification shape
 * (balance-delta output, zero-retention, fee-to-treasury, allowance reset) as
 * canary-uniswap-mainnet-v2.js / canary-kuru-mainnet-v2.js.
 *
 * Nad.Fun always pairs a token against native MON — never another ERC-20 —
 * and its router delivers output DIRECTLY to a caller-named recipient (the
 * executor sets `to = user`), so unlike Kuru there is no forward-after-
 * receive step. Router selection is off-chain (the Lens's own routing
 * decision) but the executor never trusts it blindly — it must already be
 * Safe-allowlisted (setNadFunRouter) or the trade reverts. This script
 * independently re-derives which router SHOULD be used for the requested
 * direction and asserts the Lens agrees, so a bonding-curve canary can never
 * silently execute against the graduated DEX router or vice versa.
 *
 * DIRECTION (env, required):
 *   bonding-buy    spend native MON, buy a NOT-YET-GRADUATED token (BondingCurveRouter)
 *   bonding-sell   spend that token, sell back to native MON (BondingCurveRouter)
 *   dex-buy        spend native MON, buy a GRADUATED token (DexRouter)
 *   dex-sell       spend that token, sell back to native MON (DexRouter)
 *
 * Required env (contracts/.env):
 *   MONAD_AGENT_PRIVATE_KEY          the USER wallet (funded with a little MON + the test token for sells)
 *   PAYAI_TRADE_EXECUTOR_V2_ADDRESS  deployed V2 executor
 *   DIRECTION                        bonding-buy | bonding-sell | dex-buy | dex-sell
 *   NADFUN_TEST_TOKEN                a REAL Nad.Fun token address matching the requested phase —
 *                                    never invented here; the operator running this canary must supply
 *                                    one still on the bonding curve for bonding-buy/bonding-sell, and one
 *                                    already graduated to the DEX for dex-buy/dex-sell.
 * Optional:
 *   TEST_AMOUNT_MON    default 0.01  (used for -buy directions)
 *   TEST_AMOUNT_TOKEN  required for -sell directions (human units, e.g. "1000")
 *   SLIPPAGE           default 0.05 (5% — bonding-curve/thin-liquidity prices move fast)
 *   MONAD_MAINNET_NADFUN_LENS / _BONDING_CURVE_ROUTER / _DEX_ROUTER / MONAD_MAINNET_WMON / PAYAI_TRADE_TREASURY
 *
 * Run:  DIRECTION=bonding-buy  NADFUN_TEST_TOKEN=0x... npx hardhat run scripts/canary-nadfun-mainnet-v2.js --network monad
 *       DIRECTION=bonding-sell NADFUN_TEST_TOKEN=0x... TEST_AMOUNT_TOKEN=1000 npx hardhat run scripts/canary-nadfun-mainnet-v2.js --network monad
 *       DIRECTION=dex-buy      NADFUN_TEST_TOKEN=0x... npx hardhat run scripts/canary-nadfun-mainnet-v2.js --network monad
 *       DIRECTION=dex-sell     NADFUN_TEST_TOKEN=0x... TEST_AMOUNT_TOKEN=1000 npx hardhat run scripts/canary-nadfun-mainnet-v2.js --network monad
 */

const LENS = process.env.MONAD_MAINNET_NADFUN_LENS || "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea";
const BONDING_CURVE_ROUTER = (process.env.MONAD_MAINNET_NADFUN_BONDING_CURVE_ROUTER || "0x6F6B8F1a20703309951a5127c45B49b1CD981A22").toLowerCase();
const DEX_ROUTER = (process.env.MONAD_MAINNET_NADFUN_DEX_ROUTER || "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137").toLowerCase();
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
const LENS_ABI = [
  "function getAmountOut(address _token, uint256 _amountIn, bool _isBuy) view returns (address router, uint256 amountOut)",
];

function check(label, ok, detail) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`); return ok; }

async function main() {
  const direction = process.env.DIRECTION;
  const DIRS = ["bonding-buy", "bonding-sell", "dex-buy", "dex-sell"];
  if (!DIRS.includes(direction || "")) throw new Error(`Set DIRECTION to one of: ${DIRS.join(", ")}.`);
  const addr = process.env.PAYAI_TRADE_EXECUTOR_V2_ADDRESS;
  if (!addr || !E.isAddress(addr)) throw new Error("Set PAYAI_TRADE_EXECUTOR_V2_ADDRESS.");
  const token = process.env.NADFUN_TEST_TOKEN;
  if (!token || !E.isAddress(token)) throw new Error("Set NADFUN_TEST_TOKEN to a real Nad.Fun token address matching this direction's phase.");

  const isBonding = direction.startsWith("bonding-");
  const isBuy = direction.endsWith("-buy");
  const expectedRouter = isBonding ? BONDING_CURVE_ROUTER : DEX_ROUTER;
  const expectedRouterLabel = isBonding ? "BondingCurveRouter" : "DexRouter";

  const [user] = await E.getSigners();
  if (!user) throw new Error("No signer. Set MONAD_AGENT_PRIVATE_KEY (USER wallet).");
  const net = await E.provider.getNetwork();
  if (net.chainId !== 143n) throw new Error(`Expected Monad mainnet chainId 143, got ${net.chainId}.`);
  if (user.address.toLowerCase() === TREASURY.toLowerCase()) throw new Error("USER signer must NOT be the treasury/Safe.");

  const erc20 = new E.Contract(token, ERC20_ABI, user);
  const tokenDec = Number(await erc20.decimals());

  const tokenIn = isBuy ? NATIVE : token;
  const tokenOut = isBuy ? token : NATIVE;
  const inDec = isBuy ? 18 : tokenDec;
  const outDec = isBuy ? tokenDec : 18;

  const grossHumanStr = isBuy
    ? (process.env.TEST_AMOUNT_MON || "0.01")
    : (process.env.TEST_AMOUNT_TOKEN || (() => { throw new Error("Set TEST_AMOUNT_TOKEN (human units) for a -sell direction."); })());
  const gross = E.parseUnits(grossHumanStr, inDec);
  const fee = (gross * FEE_BPS) / 10000n;
  const netIn = gross - fee;
  const slippage = Number(process.env.SLIPPAGE || "0.05");

  // Query the Lens for the router this trade would ACTUALLY route through, and
  // the quote on the NET amount (what the contract actually swaps) — then
  // independently assert it matches the router this canary intends to test.
  // This is the "correct router was used" check for Nad.Fun: the executor
  // itself only accepts an allowlisted router, but proving the Lens's pick
  // for this exact token/direction is the SAME router we expect (not the
  // other phase's router) is what confirms the token is actually in the
  // phase the operator meant to test.
  const lens = new E.Contract(LENS, LENS_ABI, user);
  const [quotedRouter, quotedOut] = await lens.getAmountOut(token, netIn, isBuy);
  console.log(`── Nad.Fun V2-executor canary (${direction}) ───────────────`);
  console.log(`Executor:   ${addr}  (PayAITradeExecutorV2)`);
  console.log(`User:       ${user.address}`);
  console.log(`Token:      ${token}  (${tokenDec}d)`);
  console.log(`Expected router (${expectedRouterLabel}): ${expectedRouter}`);
  console.log(`Lens-quoted router: ${quotedRouter}`);
  if (quotedRouter.toLowerCase() !== expectedRouter) {
    throw new Error(
      `Lens routed this token to ${quotedRouter}, not the expected ${expectedRouterLabel} (${expectedRouter}). ` +
      `The token is not in the phase this DIRECTION expects — supply a token actually on the ` +
      `${isBonding ? "bonding curve" : "graduated DEX"} for this canary.`
    );
  }
  if (quotedOut <= 0n) throw new Error("Lens returned a zero quote — no liquidity/route for this token/direction right now.");

  const bps = BigInt(Math.round((1 - slippage) * 1_000_000));
  let minOut = (quotedOut * bps) / 1_000_000n;
  if (minOut === 0n && quotedOut > 0n) minOut = 1n;

  console.log(`isBuy:      ${isBuy}`);
  console.log(`tokenIn:    ${tokenIn}${isBuy ? " (native MON)" : ` (token, ${tokenDec}d)`}   tokenOut: ${tokenOut}${isBuy ? ` (token, ${tokenDec}d)` : " (native MON)"}`);
  console.log(`gross in:   ${grossHumanStr}  fee=${E.formatUnits(fee, inDec)}  net=${E.formatUnits(netIn, inDec)}`);
  console.log(`quote(net): ${E.formatUnits(quotedOut, outDec)}  minOut=${E.formatUnits(minOut, outDec)}\n`);

  const exec = await E.getContractAt("PayAITradeExecutorV2", addr, user);
  const wmon = new E.Contract(WMON, ERC20_ABI, user);
  const balNative = (who) => E.provider.getBalance(who);

  // Snapshots.
  const userOutBefore = isBuy ? await erc20.balanceOf(user.address) : await balNative(user.address);
  const treasInBefore = isBuy ? await balNative(TREASURY) : await erc20.balanceOf(TREASURY);
  const execTokenBefore = await erc20.balanceOf(addr);
  const execWmonBefore = await wmon.balanceOf(addr);
  const execNativeBefore = await balNative(addr);

  if (isBuy) {
    const userMon = await balNative(user.address);
    if (userMon < gross) throw new Error(`Insufficient MON: need ${grossHumanStr}, have ${E.formatUnits(userMon, 18)}.`);
  } else {
    const userTok = await erc20.balanceOf(user.address);
    if (userTok < gross) throw new Error(`Insufficient token balance: need ${grossHumanStr}, have ${E.formatUnits(userTok, tokenDec)}.`);
    const cur = await erc20.allowance(user.address, addr);
    if (cur < gross) {
      if (cur !== 0n) { const z = await erc20.approve(addr, 0n); await z.wait(); }
      const a = await erc20.approve(addr, gross);
      console.log(`approve(executor, ${grossHumanStr} token) [EXACT] tx: ${a.hash}`);
      if ((await a.wait()).status !== 1) throw new Error("approve reverted.");
    }
  }

  // Execute (attach value only when spending native MON — i.e. a buy).
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  console.log(`tradeNadFunExactInput...`);
  const overrides = isBuy ? { value: gross } : {};
  const tx = await exec.tradeNadFunExactInput(quotedRouter, isBuy, token, gross, minOut, deadline, overrides);
  console.log(`trade tx:   ${tx.hash}`);
  const rc = await tx.wait();
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
  const userOutAfter = isBuy ? await erc20.balanceOf(user.address) : await balNative(user.address);
  const treasInAfter = isBuy ? await balNative(TREASURY) : await erc20.balanceOf(TREASURY);
  const execTokenAfter = await erc20.balanceOf(addr);
  const execWmonAfter = await wmon.balanceOf(addr);
  const execNativeAfter = await balNative(addr);
  const execRouterAllow = await erc20.allowance(addr, quotedRouter); // executor should reset to 0 (sell only)
  const userExecAllow = isBuy ? 0n : await erc20.allowance(user.address, addr);

  console.log("── On-chain verification ─────────────────────────────────");
  let ok = true;
  ok &= check("Trade succeeded", rc.status === 1);
  ok &= check("User is the signer (event.user == msg.sender)", ev.args.user.toLowerCase() === user.address.toLowerCase(), ev.args.user);
  ok &= check("TradeExecuted event exists", true);
  ok &= check("Correct venue == NADFUN(2)", Number(ev.args.venue) === 2, `venue=${ev.args.venue}`);
  ok &= check("Correct tokenIn", ev.args.tokenIn.toLowerCase() === tokenIn.toLowerCase(), ev.args.tokenIn);
  ok &= check("Correct tokenOut", ev.args.tokenOut.toLowerCase() === tokenOut.toLowerCase(), ev.args.tokenOut);
  ok &= check("Correct amountIn == gross", ev.args.amountIn === gross, `${ev.args.amountIn}`);
  ok &= check("amountOut >= minOut", amountOut >= minOut, `out=${E.formatUnits(amountOut, outDec)} minOut=${E.formatUnits(minOut, outDec)}`);
  ok &= check("Correct 0.25% fee (event.feeAmount == gross*25/10000)", feeAmount === fee, `${E.formatUnits(feeAmount, inDec)}`);
  ok &= check("Treasury received the fee (tokenIn delta == fee)", (treasInAfter - treasInBefore) === fee, `${E.formatUnits(treasInAfter - treasInBefore, inDec)}`);
  if (isBuy) {
    // Token output is exact (ERC-20 delta, no gas confound).
    const userOutDelta = userOutAfter - userOutBefore;
    ok &= check("User received the output (delta == amountOut)", userOutDelta === amountOut,
      `delta=${E.formatUnits(userOutDelta, outDec)} out=${E.formatUnits(amountOut, outDec)}`);
  } else {
    // Native output is gas-confounded off-chain; amountOut is the contract's own
    // authoritative user-delta. Prove the user's native balance rose by amountOut
    // net of a small, gas-sized shortfall — same treatment as the Uniswap/Kuru
    // canaries' native leg.
    const rawDelta = userOutAfter - userOutBefore;
    const gap = amountOut - rawDelta;
    ok &= check("User received the output (native, gas-independent)",
      rawDelta > 0n && gap >= 0n,
      `nativeDelta=${E.formatUnits(rawDelta, outDec)} amountOut=${E.formatUnits(amountOut, outDec)} impliedGas=${E.formatUnits(gap, outDec)}`);
  }
  ok &= check("Executor retains zero of the token", execTokenAfter === 0n, `${execTokenAfter}`);
  ok &= check("Executor retains zero WMON", execWmonAfter === 0n, `${execWmonAfter}`);
  // The bonding-curve BUY is the case most worth double-checking for native
  // dust: the router is paid via `{value: net}` and delivers output directly
  // to `to = user`, so nothing should ever round-trip back through the
  // executor — a nonzero balance here would mean the router refunded excess
  // value TO the executor instead of the caller, which _refundResidualInput
  // in the contract is supposed to catch and forward, not leave behind.
  ok &= check("Executor retains zero native MON (bonding-curve BUY dust check)", execNativeAfter === 0n, `${execNativeAfter}`);
  if (!isBuy) ok &= check("No leftover executor->router allowance (== 0)", execRouterAllow === 0n, `${execRouterAllow}`);
  if (!isBuy) ok &= check("No leftover user->executor allowance (== 0)", userExecAllow === 0n, `${userExecAllow}`);
  ok &= check("Tx interacted with PayAITradeExecutorV2 (emitter == executor)", rc.logs.some(l => l.address.toLowerCase() === addr.toLowerCase()));
  ok &= check(`Correct router used (${expectedRouterLabel})`, quotedRouter.toLowerCase() === expectedRouter, quotedRouter);

  console.log(`\n── TradeExecuted (decoded) ──`);
  console.log(`  tradeId=${ev.args.tradeId} user=${ev.args.user} venue=${ev.args.venue}`);
  console.log(`  tokenIn=${ev.args.tokenIn} tokenOut=${ev.args.tokenOut}`);
  console.log(`  amountIn=${ev.args.amountIn} amountOut=${ev.args.amountOut} feeAmount=${ev.args.feeAmount}`);
  console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} — Nad.Fun ${direction}`);
  if (!ok) {
    console.log("\nSTOP if this failed — do not add a workaround, do not modify the contract.");
    console.log("Report the failure output above for review.");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
