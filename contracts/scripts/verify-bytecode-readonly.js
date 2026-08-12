const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * READ-ONLY mainnet bytecode verification for the PaymentExecutor/
 * AutomationVault/MerchantRegistry cutover. Answers one question per
 * contract: is the address currently configured in production running the
 * OLD (pre-Ultrafuzz) source, the NEW (fixed, this branch's HEAD) source, or
 * something that matches neither?
 *
 * SAFETY: this script makes exactly one read call per contract --
 * `provider.getCode(address)` -- via a plain JSON-RPC provider. It never
 * constructs a signer, never sends a transaction, and takes no private key.
 * It is safe to run against production mainnet.
 *
 * METHOD: `contracts/verification/bytecode-reference-2026-08-12.json` holds
 * pre-computed runtime bytecode for both source versions of all three
 * contracts, deployed locally (Hardhat's in-memory network) with the SAME
 * constructor identity values as the real production deployments (see the
 * comment in that file's generator for the exact source commits used --
 * 5f42045 for "old" == the pre-Ultrafuzz baseline that matches every
 * currently-live deploy record in this repo, and this branch's HEAD for
 * "new"). Only PaymentExecutor's `merchantRegistry` field is `immutable`
 * (baked into bytecode) -- owner/agent/caps on all three contracts are
 * plain mutable storage, so they don't affect this comparison at all.
 *
 * CAVEAT (read before trusting a FAIL result): the reference bytecode was
 * compiled with solc 0.8.26 because this sandbox cannot reach
 * binaries.soliditylang.org to fetch the exact 0.8.24 pinned in
 * hardhat.config.js. Solidity's CBOR metadata trailer (which encodes
 * compiler version + source hash) is stripped from BOTH sides before
 * comparing for exactly this reason -- the comparison below is over
 * executable opcodes only. A patch-version difference between 0.8.24 and
 * 0.8.26 is very unlikely to change codegen for this code, but it is not
 * mathematically impossible. Treat a MATCH as strong evidence (opcode-level
 * equality against a specific known source). Treat "MATCHES NEITHER" as a
 * signal to re-run a fully rigorous comparison with the exact pinned
 * compiler (`cd contracts && npx hardhat compile` on a machine that CAN
 * reach binaries.soliditylang.org, then re-diff) before concluding the live
 * contract is neither of the two known versions.
 *
 * Required env:
 *   MONAD_MAINNET_RPC              -- defaults to https://rpc.monad.xyz.
 *   MONAD_MAINNET_PAYMENT_EXECUTOR
 *   MONAD_MAINNET_AUTOMATION_VAULT
 *   MONAD_MAINNET_MERCHANT_REGISTRY
 *
 * Run with (from contracts/):
 *   npx hardhat run scripts/verify-bytecode-readonly.js --network monad
 */

const REFERENCE_FILE = path.join(__dirname, "..", "verification", "bytecode-reference-2026-08-12.json");

function stripMetadata(hexCode) {
  const hex = hexCode.startsWith("0x") ? hexCode.slice(2) : hexCode;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 2) return hex;
  const len = bytes.readUInt16BE(bytes.length - 2);
  if (len + 2 > bytes.length) return hex;
  return bytes.slice(0, bytes.length - 2 - len).toString("hex");
}

function verdict(liveStripped, oldStripped, newStripped) {
  const live = liveStripped.replace(/^0x/, "");
  const old = oldStripped.replace(/^0x/, "");
  const nw = newStripped.replace(/^0x/, "");
  if (live === old) return "MATCHES OLD (pre-fix) SOURCE";
  if (live === nw) return "MATCHES NEW (fixed) SOURCE";
  return "MATCHES NEITHER REFERENCE";
}

async function main() {
  if (!fs.existsSync(REFERENCE_FILE)) {
    throw new Error(`Reference file not found: ${REFERENCE_FILE}`);
  }
  const ref = JSON.parse(fs.readFileSync(REFERENCE_FILE, "utf8"));

  const rpcUrl = process.env.MONAD_MAINNET_RPC || "https://rpc.monad.xyz";
  const provider = new hre.ethers.JsonRpcProvider(rpcUrl, { chainId: 143, name: "monad" });

  console.log("=".repeat(70));
  console.log("READ-ONLY BYTECODE VERIFICATION -- Monad Mainnet");
  console.log("=".repeat(70));
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Reference bytecode compiled with: ${ref.solcVersionUsed} (see CAVEAT in file header)`);
  console.log(`Reference generated at: ${ref.generatedAt}`);
  console.log("");

  const targets = [
    { label: "PaymentExecutor", env: "MONAD_MAINNET_PAYMENT_EXECUTOR", key: "PaymentExecutor" },
    { label: "AutomationVault", env: "MONAD_MAINNET_AUTOMATION_VAULT", key: "AutomationVault" },
    { label: "MerchantRegistry", env: "MONAD_MAINNET_MERCHANT_REGISTRY", key: "MerchantRegistry" },
  ];

  const results = [];
  for (const t of targets) {
    const addr = process.env[t.env];
    console.log(`--- ${t.label} ---`);
    if (!addr) {
      console.log(`  ${t.env} not set -- SKIPPED`);
      results.push({ ...t, status: "SKIPPED" });
      console.log("");
      continue;
    }
    console.log(`  Address: ${addr}`);
    try {
      const liveCode = await provider.getCode(addr);
      if (liveCode === "0x") {
        console.log("  FAIL: no contract code at this address");
        results.push({ ...t, status: "FAIL", detail: "no code" });
        console.log("");
        continue;
      }
      const liveStripped = stripMetadata(liveCode);
      const oldStripped = ref[`${t.key}_old`].strippedCode;
      const newStripped = ref[`${t.key}_new`].strippedCode;
      const v = verdict(liveStripped, oldStripped, newStripped);
      console.log(`  Live runtime bytecode length: ${liveCode.length} chars`);
      console.log(`  Result: ${v}`);
      results.push({ ...t, status: v, addr });
    } catch (e) {
      const reason = e?.shortMessage || e?.message || String(e);
      console.log(`  FAIL: RPC read failed -- ${reason}`);
      results.push({ ...t, status: "FAIL", detail: reason });
    }
    console.log("");
  }

  console.log("=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  for (const r of results) {
    console.log(`${r.label.padEnd(18)} ${r.status}`);
  }
  console.log("");
  console.log("Reminder: this script did not deploy, send, or modify anything.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
