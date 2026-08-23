const hre = require("hardhat");

/**
 * Step 8.3 — REAL mainnet ERC-20 (USDC) test through the deployed PayAIForwarder.
 *
 * Proves the two-step interactive ERC-20 path end to end, exactly as the app
 * builds it:
 *   1. approve(PayAIForwarder, EXACT amount)   — never MAX_UINT256
 *   2. forwardPayment(token, recipient, amount, ref)  — payer -> recipient
 * then reads the mined receipt back and decodes PaymentForwarded from the
 * on-chain logs to prove the token really routed through the contract.
 *
 * IMPORTANT — recipient MUST differ from the payer. The contract verifies
 * delivery by the recipient's real balance delta (INVARIANT-FW-3); a
 * self-forward nets a zero delta and correctly REVERTS. So set TEST_RECIPIENT
 * to a second address you control (a tiny amount of USDC moves to it).
 *
 * Required env (contracts/.env): MONAD_AGENT_PRIVATE_KEY (funded payer).
 * Required env: TEST_RECIPIENT (a different address you control).
 * Optional: TEST_AMOUNT_USDC (default 0.01), MONAD_MAINNET_USDC (token override).
 * Run: npx hardhat run scripts/test-forwarder-erc20-mainnet.js --network monad
 */

const FORWARDER = process.env.PAYAI_FORWARDER_ADDRESS
  || "0x4ce7B3036595eDA699Aebeb47b34fd4bc4F80709";
// Monad mainnet USDC — confirmed in contracts/LIVE_CONTRACTS.md (/api/automation-config,
// matches lib/monad/swap.ts + Kuru's official token list). 6 decimals.
const USDC = process.env.MONAD_MAINNET_USDC
  || "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function main() {
  const [payer] = await hre.ethers.getSigners();
  if (!payer) throw new Error("No signer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const net = await hre.ethers.provider.getNetwork();
  if (net.chainId !== 143n) throw new Error(`Expected Monad mainnet chainId 143, got ${net.chainId}.`);

  const recipient = process.env.TEST_RECIPIENT;
  if (!recipient || !hre.ethers.isAddress(recipient)) {
    throw new Error("Set TEST_RECIPIENT to a valid address you control (must differ from the payer).");
  }
  if (recipient.toLowerCase() === payer.address.toLowerCase()) {
    throw new Error("TEST_RECIPIENT must be a DIFFERENT address than the payer — a self-forward reverts by design (balance-delta guard).");
  }

  const token = new hre.ethers.Contract(USDC, ERC20_ABI, payer);
  const decimals = Number(await token.decimals());
  let symbol = "USDC"; try { symbol = await token.symbol(); } catch (_) {}
  const amountStr = process.env.TEST_AMOUNT_USDC || "0.01";
  const amount = hre.ethers.parseUnits(amountStr, decimals);
  const ref = hre.ethers.id("payai-mainnet-erc20-test");

  console.log(`Network:    chainId ${net.chainId} (Monad mainnet)`);
  console.log(`Forwarder:  ${FORWARDER}`);
  console.log(`Token:      ${USDC} (${symbol}, ${decimals} decimals)`);
  console.log(`Payer:      ${payer.address}`);
  console.log(`Recipient:  ${recipient}`);
  console.log(`Amount:     ${amountStr} ${symbol} (${amount} base units)`);
  console.log(`Ref:        ${ref}`);

  const payerBal = await token.balanceOf(payer.address);
  console.log(`\nPayer ${symbol} balance: ${hre.ethers.formatUnits(payerBal, decimals)}`);
  if (payerBal < amount) throw new Error(`Insufficient ${symbol}: need ${amountStr}, have ${hre.ethers.formatUnits(payerBal, decimals)}.`);

  // Step 1 — approve EXACT amount only if the current allowance is short.
  const current = await token.allowance(payer.address, FORWARDER);
  console.log(`Current allowance -> forwarder: ${hre.ethers.formatUnits(current, decimals)} ${symbol}`);
  if (current < amount) {
    console.log(`\nStep 1 of 2 — approve(forwarder, ${amountStr} ${symbol}) [EXACT amount, not MAX]...`);
    const aTx = await token.approve(FORWARDER, amount);
    console.log(`Approve tx: ${aTx.hash}`);
    const aRc = await aTx.wait();
    if (aRc.status !== 1) throw new Error("Approval reverted.");
    console.log(`Approve:    SUCCESS (block ${aRc.blockNumber})`);
  } else {
    console.log(`Allowance already sufficient — skipping approve.`);
  }

  // Step 2 — forwardPayment(token, recipient, amount, ref).
  const forwarder = await hre.ethers.getContractAt("PayAIForwarder", FORWARDER, payer);
  const recipBefore = await token.balanceOf(recipient);
  console.log(`\nStep 2 of 2 — forwardPayment...`);
  const fTx = await forwarder.forwardPayment(USDC, recipient, amount, ref);
  console.log(`Forward tx: ${fTx.hash}`);
  const rc = await fTx.wait();
  console.log(`Status:     ${rc.status === 1 ? "SUCCESS" : "REVERTED"} (block ${rc.blockNumber})`);

  // Decode PaymentForwarded from the mined logs — authoritative proof.
  const iface = forwarder.interface;
  let found = null;
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== FORWARDER.toLowerCase()) continue;
    try { const p = iface.parseLog(log); if (p && p.name === "PaymentForwarded") { found = p; break; } } catch (_) {}
  }
  if (!found) throw new Error("No PaymentForwarded event in receipt — traceability NOT proven.");

  console.log(`\n── PaymentForwarded (decoded from on-chain logs) ──`);
  console.log(`  id:        ${found.args.id}`);
  console.log(`  payer:     ${found.args.payer}`);
  console.log(`  recipient: ${found.args.recipient}`);
  console.log(`  token:     ${found.args.token}`);
  console.log(`  amount:    ${found.args.amount} (${hre.ethers.formatUnits(found.args.amount, decimals)} ${symbol})`);
  console.log(`  ref:       ${found.args.ref}`);

  const recipAfter = await token.balanceOf(recipient);
  const delta = recipAfter - recipBefore;
  console.log(`\nRecipient ${symbol}: ${hre.ethers.formatUnits(recipBefore, decimals)} -> ${hre.ethers.formatUnits(recipAfter, decimals)} (delta ${hre.ethers.formatUnits(delta, decimals)})`);
  console.log(`Explorer tx:   https://monadexplorer.com/tx/${fTx.hash}`);

  const ok =
    found.args.payer.toLowerCase() === payer.address.toLowerCase() &&
    found.args.recipient.toLowerCase() === recipient.toLowerCase() &&
    found.args.token.toLowerCase() === USDC.toLowerCase() &&
    found.args.amount === amount &&
    found.args.ref === ref &&
    delta === amount;

  console.log(`\nRESULT: ${ok ? "PASS — approve(exact) + payer -> PayAIForwarder -> recipient proven on-chain for " + symbol + "." : "FAIL — event/balance did not match the requested payment."}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
