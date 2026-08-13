const hre = require("hardhat");

/**
 * End-to-end Monad mainnet environment check for PayAI contracts.
 *
 * Traces the WHOLE chain in order, so a failure tells you exactly which link
 * broke instead of surfacing as a confusing downstream error:
 *
 *   RPC reachable -> chainId correct -> provider works -> signer exists ->
 *   signer has gas -> token address set -> token has code -> ERC-20 reads ->
 *   allowance read -> (optional, explicitly opted into) approve write.
 *
 * READ-ONLY BY DEFAULT. The approve step at the end is skipped unless you
 * explicitly set SEND_APPROVE=true AND APPROVE_AMOUNT. Nothing else in this
 * script can ever send a transaction.
 *
 * WHY A LOCAL ERC20_ABI INSTEAD OF getContractAt("IERC20", ...):
 * this project declares THREE separate `interface IERC20` blocks (in
 * AutomationVault.sol, PaymentExecutor.sol, and VeriPayRegistry.sol), which is
 * what produces Hardhat's "multiple artifacts for contract IERC20, please use
 * a fully qualified name" error. But disambiguating with a fully-qualified
 * name would NOT actually help here: none of those three interfaces declares
 * `approve` or `allowance` -- they only declare the subset each contract
 * actually calls (transferFrom/transfer/balanceOf). That is precisely why
 * calling `.approve(...)` on a contract loaded from a project IERC20 artifact
 * throws "Cannot read properties of undefined (reading 'approve')": the method
 * genuinely isn't in that ABI. The correct fix for talking to a real ERC-20 is
 * a real ERC-20 ABI, which is what's used below. The three in-contract
 * interfaces are deliberately left alone -- they're minimal on purpose, and
 * editing them would change contract source (and therefore bytecode) for
 * contracts that were just deployed and bytecode-verified.
 *
 * Required env (contracts/.env, loaded automatically by hardhat.config.js):
 *   MONAD_MAINNET_RPC       -- Monad mainnet RPC URL.
 *   MONAD_AGENT_PRIVATE_KEY -- agent hot key. Without it, hardhat.config.js's
 *                              `accounts` array is EMPTY, getSigners() returns
 *                              [], and `const [signer] = await
 *                              ethers.getSigners()` leaves signer === undefined
 *                              -- the root cause of "signer is undefined" and
 *                              "contract runner does not support calling".
 *   TOKEN_ADDRESS           -- ERC-20 to check. Falls back to
 *                              MONAD_MAINNET_USDC if that's set instead.
 * Optional:
 *   SPENDER_ADDRESS         -- allowance/approve spender. Defaults to
 *                              MONAD_MAINNET_PAYMENT_EXECUTOR (the usual
 *                              spender: the executor pulls the agent's ERC-20).
 *   SEND_APPROVE=true       -- opt in to actually sending the approve tx.
 *   APPROVE_AMOUNT          -- human-readable amount (e.g. "1000"), required
 *                              when SEND_APPROVE=true. Scaled by decimals().
 *
 * Run (from contracts/):
 *   npx hardhat run scripts/test-monad.js --network monad
 */

// Minimal but COMPLETE standard ERC-20 ABI -- includes approve/allowance,
// unlike any of the project's three internal IERC20 interfaces.
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

const EXPECTED_CHAIN_ID = 143n;

let failures = 0;
function pass(label, detail) {
  console.log(`  PASS  ${label}${detail ? " -- " + detail : ""}`);
}
function fail(label, detail) {
  failures++;
  console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`);
}
function skip(label, detail) {
  console.log(`  SKIP  ${label}${detail ? " -- " + detail : ""}`);
}
function section(title) {
  console.log("\n" + "-".repeat(68));
  console.log(title);
  console.log("-".repeat(68));
}

async function main() {
  console.log("=".repeat(68));
  console.log("PayAI -- Monad mainnet environment check");
  console.log("=".repeat(68));
  console.log(`Hardhat network: ${hre.network.name}`);
  console.log(`Configured RPC:  ${hre.network.config.url}`);
  console.log(`Configured chainId: ${hre.network.config.chainId}`);

  /* 1. RPC + network detection ------------------------------------------- */
  section("1. RPC connectivity & network detection");
  const provider = hre.ethers.provider;
  let net;
  try {
    net = await provider.getNetwork();
    pass("RPC reachable, network detected", `chainId ${net.chainId}`);
  } catch (e) {
    const msg = e?.shortMessage || e?.message || String(e);
    if (msg.includes("HH101")) {
      // Hardhat's OWN guard: hardhat.config.js pins chainId 143 for the
      // "monad" network, and the endpoint you're actually talking to reports
      // something else. This is a wrong-endpoint / wrong-chain configuration
      // problem, not a reachability problem -- the RPC responded just fine.
      fail("configured RPC is not Monad mainnet", msg);
      console.log("\n  hardhat.config.js expects chainId 143 (Monad mainnet). The endpoint at");
      console.log("  MONAD_MAINNET_RPC responded with a DIFFERENT chain id -- it answered the");
      console.log("  request, it's just not Monad mainnet. Double-check the URL; do not proceed.");
    } else {
      fail("RPC unreachable", msg);
      console.log("\n  This is an EXTERNAL dependency failure, not a code problem.");
      console.log("  403 Forbidden / ECONNRESET / EAI_AGAIN / UND_ERR_CONNECT_TIMEOUT here all mean");
      console.log("  the request never got a valid JSON-RPC response from the endpoint. Check:");
      console.log("    - MONAD_MAINNET_RPC in contracts/.env points at a Monad MAINNET endpoint");
      console.log("    - the endpoint isn't rate-limiting or geo/IP-blocking you (403 is typical of both)");
      console.log("    - no corporate proxy/VPN/DNS filter is intercepting the hostname");
    }
    console.log("  Nothing further in this script can run without a working RPC.");
    process.exitCode = 1;
    return;
  }

  if (net.chainId === EXPECTED_CHAIN_ID) {
    pass("chainId matches Monad mainnet", `${EXPECTED_CHAIN_ID}`);
  } else {
    fail("chainId MISMATCH", `endpoint reports ${net.chainId}, expected ${EXPECTED_CHAIN_ID} (Monad mainnet)`);
    console.log("  The RPC URL is pointing at the wrong chain. Do not send anything through it.");
    process.exitCode = 1;
    return;
  }

  try {
    const blockNumber = await provider.getBlockNumber();
    const block = await provider.getBlock(blockNumber);
    const ageSec = block ? Math.floor(Date.now() / 1000) - Number(block.timestamp) : null;
    pass("latest block readable", `#${blockNumber}${ageSec !== null ? `, ${ageSec}s old` : ""}`);
    if (ageSec !== null && ageSec > 300) {
      console.log(`  WARNING: latest block is ${ageSec}s old -- this endpoint may be stale/lagging.`);
    }
  } catch (e) {
    fail("could not read latest block", e?.shortMessage || e?.message);
  }

  /* 2. Signer ------------------------------------------------------------- */
  section("2. Signer (write capability)");
  const signers = await hre.ethers.getSigners();
  let signer = signers[0];
  if (!signer) {
    fail("no signer available", "getSigners() returned an empty array");
    console.log("  ROOT CAUSE: hardhat.config.js builds its `accounts` array from");
    console.log("  MONAD_AGENT_PRIVATE_KEY (or PRIVATE_KEY). Neither is set, so `accounts` is []");
    console.log("  and `const [signer] = await ethers.getSigners()` yields undefined.");
    console.log("  Every downstream symptom follows from this:");
    console.log('    - "Cannot read properties of undefined (reading \'approve\')"');
    console.log('    - "contract runner does not support calling" (UNSUPPORTED_OPERATION)');
    console.log("  Fix: put MONAD_AGENT_PRIVATE_KEY=0x... in contracts/.env (never commit it).");
    console.log("  Read-only checks below will continue using the provider.");
  } else {
    const addr = await signer.getAddress();
    pass("signer available", addr);
    const bal = await provider.getBalance(addr);
    const balMon = hre.ethers.formatEther(bal);
    if (bal === 0n) {
      fail("signer MON balance is 0", "cannot pay gas for any transaction");
    } else {
      pass("signer has gas", `${balMon} MON`);
    }
  }

  /* 3. Token contract ----------------------------------------------------- */
  section("3. Token contract");
  const tokenAddr = process.env.TOKEN_ADDRESS || process.env.MONAD_MAINNET_USDC;
  if (!tokenAddr) {
    fail("no token address configured", "set TOKEN_ADDRESS or MONAD_MAINNET_USDC in contracts/.env");
    console.log("  Deliberately NOT guessing an address -- pull the real value from your");
    console.log("  Vercel production env (MONAD_MAINNET_USDC) rather than inventing one.");
    printSummary();
    return;
  }
  console.log(`  Token address: ${tokenAddr}`);

  let code;
  try {
    code = await provider.getCode(tokenAddr);
  } catch (e) {
    fail("could not read code at token address", e?.shortMessage || e?.message);
    printSummary();
    return;
  }
  if (code === "0x") {
    fail("no contract code at token address", "this address is an EOA or nothing at all on this chain");
    printSummary();
    return;
  }
  pass("contract code exists at token address", `${(code.length - 2) / 2} bytes`);

  // Read-only instance bound to the PROVIDER (correct for view calls).
  const tokenRead = new hre.ethers.Contract(tokenAddr, ERC20_ABI, provider);

  let decimals = 18;
  let symbol = "TOKEN";
  try {
    decimals = Number(await tokenRead.decimals());
    symbol = await tokenRead.symbol();
    const name = await tokenRead.name();
    pass("ERC-20 metadata reads", `${name} (${symbol}), ${decimals} decimals`);
  } catch (e) {
    fail("ERC-20 metadata read failed", `${e?.shortMessage || e?.message} -- is this really an ERC-20?`);
  }

  /* 4. Balances & allowance ---------------------------------------------- */
  section("4. ERC-20 reads (balanceOf / allowance)");
  const spender = process.env.SPENDER_ADDRESS || process.env.MONAD_MAINNET_PAYMENT_EXECUTOR;

  if (signer) {
    const owner = await signer.getAddress();
    try {
      const bal = await tokenRead.balanceOf(owner);
      pass("balanceOf(signer)", `${hre.ethers.formatUnits(bal, decimals)} ${symbol}`);
    } catch (e) {
      fail("balanceOf failed", e?.shortMessage || e?.message);
    }

    if (!spender) {
      skip("allowance", "no SPENDER_ADDRESS / MONAD_MAINNET_PAYMENT_EXECUTOR set");
    } else {
      console.log(`  Spender: ${spender}`);
      try {
        const allowance = await tokenRead.allowance(owner, spender);
        pass("allowance(signer, spender)", `${hre.ethers.formatUnits(allowance, decimals)} ${symbol}`);
        if (allowance === 0n) {
          console.log("  NOTE: allowance is 0. If this spender is a PaymentExecutor, its ERC-20");
          console.log("  payment path will revert with \"transfer failed\" until an approve() lands.");
          console.log("  ERC-20 approvals are per-spender: a new executor always needs a fresh one.");
        }
      } catch (e) {
        fail("allowance failed", e?.shortMessage || e?.message);
      }
    }
  } else {
    skip("balanceOf/allowance for signer", "no signer (see section 2)");
  }

  /* 5. Approve (opt-in write) -------------------------------------------- */
  section("5. approve() -- WRITE, opt-in only");
  const wantApprove = String(process.env.SEND_APPROVE || "").toLowerCase() === "true";
  if (!wantApprove) {
    skip("approve", "read-only run. Set SEND_APPROVE=true and APPROVE_AMOUNT to send one.");
  } else if (!signer) {
    fail("approve", "cannot send without a signer (see section 2)");
  } else if (!spender) {
    fail("approve", "no SPENDER_ADDRESS / MONAD_MAINNET_PAYMENT_EXECUTOR set");
  } else if (!process.env.APPROVE_AMOUNT) {
    fail("approve", "SEND_APPROVE=true but APPROVE_AMOUNT is not set -- refusing to guess an amount");
  } else {
    // Write instance bound to the SIGNER (a provider-bound contract cannot send).
    const tokenWrite = new hre.ethers.Contract(tokenAddr, ERC20_ABI, signer);
    const amount = hre.ethers.parseUnits(process.env.APPROVE_AMOUNT, decimals);
    console.log(`  Sending approve(${spender}, ${process.env.APPROVE_AMOUNT} ${symbol})...`);
    console.log("  This IS a real mainnet transaction and costs gas.");
    const tx = await tokenWrite.approve(spender, amount);
    console.log(`  tx hash: ${tx.hash} -- waiting for confirmation...`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      pass("approve confirmed", `block ${receipt.blockNumber}`);
      const newAllowance = await tokenRead.allowance(await signer.getAddress(), spender);
      pass("allowance after approve", `${hre.ethers.formatUnits(newAllowance, decimals)} ${symbol}`);
    } else {
      fail("approve reverted", `status ${receipt.status}`);
    }
  }

  printSummary();
}

function printSummary() {
  console.log("\n" + "=".repeat(68));
  console.log(failures === 0 ? "RESULT: all checks passed" : `RESULT: ${failures} check(s) FAILED -- see above`);
  console.log("=".repeat(68));
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\nUnhandled error:", e?.shortMessage || e?.message || e);
  process.exitCode = 1;
});
