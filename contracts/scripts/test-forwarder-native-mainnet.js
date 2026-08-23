const hre = require("hardhat");

/**
 * Step 8.3 — REAL mainnet native-MON test through the deployed PayAIForwarder.
 *
 * Sends ONE tiny native-MON payment (default 0.001 MON) through
 * forwardPaymentNative(recipient, amount, ref) so the chain shows the full
 * PayAI footprint: payer -> PayAIForwarder -> recipient, in one tx, with a
 * canonical PaymentForwarded event. It then reads the mined receipt back and
 * decodes that event from the on-chain logs (never from anything the client
 * claims) to prove the payment really routed through the contract.
 *
 * Safe by construction:
 *   - Tiny amount. Override with TEST_AMOUNT_MON if you want an even smaller one.
 *   - recipient defaults to the payer's OWN address (a self-forward still proves
 *     the path + emits the real event; the MON comes straight back minus gas).
 *     Override with TEST_RECIPIENT to send to a different address.
 *   - Reverts leave your MON untouched — the contract never retains funds.
 *
 * Required env (contracts/.env): MONAD_AGENT_PRIVATE_KEY (the funded payer).
 * Run: npx hardhat run scripts/test-forwarder-native-mainnet.js --network monad
 */

const FORWARDER = process.env.PAYAI_FORWARDER_ADDRESS
  || "0x4ce7B3036595eDA699Aebeb47b34fd4bc4F80709"; // deployed on Monad mainnet, source-verified

async function main() {
  const [payer] = await hre.ethers.getSigners();
  if (!payer) throw new Error("No signer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");

  const net = await hre.ethers.provider.getNetwork();
  if (net.chainId !== 143n) {
    throw new Error(`Refusing to run: expected Monad mainnet chainId 143, got ${net.chainId}.`);
  }

  const recipient = process.env.TEST_RECIPIENT || payer.address;
  const amountMon = process.env.TEST_AMOUNT_MON || "0.001";
  const amount = hre.ethers.parseEther(amountMon);
  const ref = hre.ethers.id("payai-mainnet-native-test"); // keccak256 of a label

  console.log(`Network:    chainId ${net.chainId} (Monad mainnet)`);
  console.log(`Forwarder:  ${FORWARDER}`);
  console.log(`Payer:      ${payer.address}`);
  console.log(`Recipient:  ${recipient}${recipient.toLowerCase() === payer.address.toLowerCase() ? " (self — MON returns minus gas)" : ""}`);
  console.log(`Amount:     ${amountMon} MON (${amount} wei)`);
  console.log(`Ref:        ${ref}`);

  const forwarder = await hre.ethers.getContractAt("PayAIForwarder", FORWARDER, payer);

  const balBefore = await hre.ethers.provider.getBalance(payer.address);
  console.log(`\nSending forwardPaymentNative...`);
  const tx = await forwarder.forwardPaymentNative(recipient, amount, ref, { value: amount });
  console.log(`Tx hash:    ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Status:     ${receipt.status === 1 ? "SUCCESS" : "REVERTED"}`);
  console.log(`Block:      ${receipt.blockNumber}`);

  // Decode PaymentForwarded straight from the mined logs — the authoritative proof.
  const iface = forwarder.interface;
  let found = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== FORWARDER.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "PaymentForwarded") { found = parsed; break; }
    } catch (_) { /* not our event */ }
  }

  if (!found) {
    throw new Error("No PaymentForwarded event found in the receipt — traceability NOT proven.");
  }

  console.log(`\n── PaymentForwarded (decoded from on-chain logs) ──`);
  console.log(`  id:        ${found.args.id}`);
  console.log(`  payer:     ${found.args.payer}`);
  console.log(`  recipient: ${found.args.recipient}`);
  console.log(`  token:     ${found.args.token}  ${found.args.token === hre.ethers.ZeroAddress ? "(native MON)" : ""}`);
  console.log(`  amount:    ${found.args.amount} wei (${hre.ethers.formatEther(found.args.amount)} MON)`);
  console.log(`  ref:       ${found.args.ref}`);

  // Independent assertions — fail loudly if anything doesn't match what we sent.
  const ok =
    found.args.payer.toLowerCase() === payer.address.toLowerCase() &&
    found.args.recipient.toLowerCase() === recipient.toLowerCase() &&
    found.args.token === hre.ethers.ZeroAddress &&
    found.args.amount === amount &&
    found.args.ref === ref;

  const balAfter = await hre.ethers.provider.getBalance(payer.address);
  console.log(`\nPayer balance: ${hre.ethers.formatEther(balBefore)} -> ${hre.ethers.formatEther(balAfter)} MON`);
  console.log(`Explorer tx:   https://monadexplorer.com/tx/${tx.hash}`);
  console.log(`Explorer addr: https://monadexplorer.com/address/${FORWARDER}`);

  console.log(`\nRESULT: ${ok ? "PASS — payer -> PayAIForwarder -> recipient proven on-chain." : "FAIL — event fields did not match the requested payment."}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
