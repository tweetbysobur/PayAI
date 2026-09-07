const hre = require("hardhat");

/**
 * Minimal mainnet smoke test for a deployed SplitSettlement. Splits a tiny
 * amount of native MON from the signer to two recipients (defaults to the
 * signer itself, twice — duplicates are allowed, so the funds return to the
 * signer minus gas) and checks the on-chain outcome:
 *   - SplitPaymentExecuted emitted with the expected fields
 *   - settlementId == the pre-call settlementCount
 *   - totalAmount == the sum of amounts
 *   - contract balance unchanged (delta-based zero-retention)
 *
 * A one-shot script instead of the REPL so there is no console state to fight.
 *
 * Usage (from contracts/):
 *   SPLIT_SETTLEMENT_ADDRESS=0x… npx hardhat run scripts/smoke-split-settlement.js --network monad
 * Address defaults to the canonical deployment below if the env var is unset.
 * Optional: SMOKE_AMOUNT_MON (default "0.001" per recipient).
 */

const DEFAULT_ADDRESS = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";

async function main() {
  const address = process.env.SPLIT_SETTLEMENT_ADDRESS || DEFAULT_ADDRESS;
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("No signer. Set MONAD_AGENT_PRIVATE_KEY in contracts/.env.");
  const me = signer.address;
  const a = hre.ethers.parseEther(process.env.SMOKE_AMOUNT_MON || "0.001");

  const c = await hre.ethers.getContractAt("SplitSettlement", address);

  const beforeCount = await c.settlementCount();
  const beforeBal = await hre.ethers.provider.getBalance(address);
  console.log("Contract:", address);
  console.log("Signer:  ", me);
  console.log(`Before -> settlementCount=${beforeCount} contractBalance=${beforeBal}`);

  console.log(`\nsplitPayment(native, [me, me], [${a}, ${a}], value=${a * 2n})…`);
  const tx = await c.splitPayment(hre.ethers.ZeroAddress, [me, me], [a, a], hre.ethers.ZeroHash, { value: a * 2n });
  const rc = await tx.wait();
  console.log("tx:   ", rc.hash);
  console.log("block:", rc.blockNumber);

  let ev = null;
  const names = [];
  for (const log of rc.logs) {
    try {
      const p = c.interface.parseLog(log);
      if (p) {
        names.push(p.name);
        if (p.name === "SplitPaymentExecuted") ev = p;
      }
    } catch {
      /* not one of ours */
    }
  }
  console.log("events:", names);
  if (ev) {
    console.log("  settlementId:", ev.args.settlementId.toString());
    console.log("  payer:       ", ev.args.payer);
    console.log("  token:       ", ev.args.token);
    console.log("  totalAmount: ", ev.args.totalAmount.toString());
    console.log("  recipients:  ", ev.args.recipients);
    console.log("  amounts:     ", ev.args.amounts.map((x) => x.toString()));
  }

  const afterCount = await c.settlementCount();
  const afterBal = await hre.ethers.provider.getBalance(address);
  console.log(`After  -> settlementCount=${afterCount} contractBalance=${afterBal}`);

  const checks = {
    "event emitted": !!ev,
    "settlementId == prior count": ev && ev.args.settlementId === beforeCount,
    "totalAmount == sum": ev && ev.args.totalAmount === a * 2n,
    "count incremented by 1": afterCount === beforeCount + 1n,
    "zero-retention (balance unchanged)": afterBal === beforeBal,
    "owner still Safe": (await c.owner()).toLowerCase() === "0xa282833b52b1b66d58bd2007081dcc037798c0b0",
    "not paused": (await c.paused()) === false,
  };
  console.log("\n── Checks ──");
  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? "✓" : "✗"} ${k}`);
    if (!v) allOk = false;
  }
  console.log(allOk ? "\n✅ SMOKE TEST PASSED" : "\n❌ SMOKE TEST MISMATCH — review above");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
