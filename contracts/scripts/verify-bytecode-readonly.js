const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * READ-ONLY mainnet bytecode verification for the PaymentExecutor/
 * AutomationVault/MerchantRegistry cutover. Answers one question per
 * contract: is the address currently configured in production running the
 * OLD (pre-Ultrafuzz) source, the NEW (fixed, this branch's HEAD) source, or
 * neither?
 *
 * SAFETY: this script makes exactly one read call per contract --
 * `provider.getCode(address)` -- via a plain JSON-RPC provider. It never
 * constructs a signer, never sends a transaction, and takes no private key.
 * It is safe to run against production mainnet.
 *
 * SOURCE COMMITS (corrected -- see investigation note below): "old" for
 * PaymentExecutor is commit 8161185 (2026-07-22 11:50 UTC, ~30 min before
 * the recorded v4 deploy timestamp 2026-07-22T12:20:43Z, no intervening
 * commits touch the file); "old" for AutomationVault is commit 43ea8c8
 * (2026-07-08 23:14 UTC, ~104 SECONDS before the recorded v3-fresh deploy
 * timestamp 2026-07-08T23:16:18Z); "old" for MerchantRegistry is commit
 * 0b64255 (initial public release, unchanged logic through the v3-fresh
 * deploy 11 days later). "new" == this branch's HEAD for all three.
 *
 * INVESTIGATION NOTE (why this file changed since the last version): an
 * earlier version of this reference was built using commit 5f42045 as the
 * "old" baseline for all three contracts. That commit turned out to sit
 * exactly at this sandbox's git shallow-clone boundary -- `git show
 * 5f42045:<path>` still returned correct blob content (git blobs are intact
 * even in a shallow clone), so the SOURCE TEXT used was not actually wrong
 * (verified by diffing against the properly-identified commits above --
 * byte-identical in all three cases). But the earlier reasoning for WHY
 * 5f42045 was the right commit was wrong (it looked like a fresh 808-line
 * addition of all three files, which was actually a shallow-clone graft
 * artifact -- comparing a boundary commit against an empty parent). The
 * repo has since been unshallowed (`git fetch --unshallow`) and the true
 * per-contract deploy-adjacent commits identified by timestamp above.
 *
 * A SEPARATE, more consequential issue was found and fixed: this repo's
 * `contracts/foundry.toml` (added later, for a subsequent redeploy, so not
 * itself applicable to these two target contracts) pins `evm_version =
 * "paris"`. `hardhat.config.js` does not set `evmVersion` at all. Empirically
 * verified in this sandbox: solc 0.8.24 left at its own default DOES emit
 * PUSH0 opcodes (Shanghai-or-later codegen), which does NOT exist under
 * Paris. Since it's unknown from the repository alone whether the ORIGINAL
 * deploy (mid-2026) ran under a Shanghai-or-later default or was pinned to
 * Paris some other way (a local hardhat.config.js edit never committed, a
 * different tool, or a Monad-node compatibility requirement at that time --
 * all REQUIRES ON-CHAIN CHECK / REQUIRES verification, not knowable from
 * source alone), this reference now includes BOTH an evmVersion-default
 * build and an evmVersion="paris" build for old AND new source, and checks
 * the live contract against all four per target.
 *
 * COMPILER: solc 0.8.24 obtained from registry.npmjs.org (reachable even
 * though binaries.soliditylang.org, Hardhat's own downloader, is not in
 * this sandbox) as the exact `solc@0.8.24` npm package -- confirmed via
 * `solc.version()` to report "0.8.24+commit.e11b9ed9.Emscripten.clang",
 * matching hardhat.config.js's pin exactly. Optimizer settings
 * (enabled: true, runs: 200) also copied exactly from hardhat.config.js.
 *
 * The comparison strips Solidity's CBOR metadata trailer before comparing
 * (see stripMetadata()) since that trailer encodes source file PATHS as
 * compiled, which differ cosmetically between this reference build (bare
 * filenames) and Hardhat's real project layout ("contracts/X.sol") -- the
 * comparison is over EXECUTABLE OPCODES ONLY.
 *
 * CONSTRUCTOR ARGS / IMMUTABLES -- can they cause a false mismatch?
 *   PaymentExecutor:  only `merchantRegistry` is `immutable`. The reference
 *     uses the real production registry address
 *     (0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb). owner/agent/all four
 *     caps are plain mutable storage -- cannot affect bytecode.
 *   AutomationVault:  NO immutable variables at all. No constructor value
 *     can affect runtime bytecode under any input.
 *   MerchantRegistry: no constructor parameters; owner = msg.sender is
 *     plain mutable storage.
 *   Verified identical in BOTH the old (pre-Ultrafuzz) and current source
 *   -- the immutable/mutable split hasn't changed. Confirmed non-issue.
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

const REFERENCE_FILE = path.join(__dirname, "..", "verification", "bytecode-reference-solc-0.8.24-exact.json");

function stripMetadata(hexCode) {
  const hex = hexCode.startsWith("0x") ? hexCode.slice(2) : hexCode;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 2) return hex;
  const len = bytes.readUInt16BE(bytes.length - 2);
  if (len + 2 > bytes.length) return hex;
  return bytes.slice(0, bytes.length - 2 - len).toString("hex");
}

/**
 * PASS  = exact opcode-level bytecode match against one of the four known
 *         references (old/new x default-evm/paris-evm).
 * FAIL  = definite mismatch against ALL FOUR known references.
 * INCONCLUSIVE = could not obtain the data needed to compare at all (no
 *         code at the address, RPC failure, env var missing).
 */
function verdict(liveStripped, ref, key) {
  const live = liveStripped.replace(/^0x/, "");
  const candidates = [
    ["OLD (pre-fix) source, default EVM target", ref[`${key}_old_default`]],
    ["OLD (pre-fix) source, Paris EVM target", ref[`${key}_old_paris`]],
    ["NEW (fixed) source, default EVM target", ref[`${key}_new_default`]],
    ["NEW (fixed) source, Paris EVM target", ref[`${key}_new_paris`]],
  ];
  for (const [label, entry] of candidates) {
    if (entry && live === entry.strippedCode.replace(/^0x/, "")) {
      return { status: "PASS", detail: `matches ${label} exactly` };
    }
  }
  return { status: "FAIL", detail: "matches none of the 4 known references (old/new x default/paris EVM target)" };
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
  console.log(`Reference compiler: ${ref.solcVersionUsed}`);
  console.log(`Reference generated at: ${ref.generatedAt}`);
  console.log("Checking each live contract against 4 references: old/new source x default/Paris EVM target.");
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
      console.log(`  ${t.env} not set -- INCONCLUSIVE (skipped)`);
      results.push({ ...t, status: "INCONCLUSIVE", detail: "env var not set" });
      console.log("");
      continue;
    }
    console.log(`  Address: ${addr}`);
    try {
      const liveCode = await provider.getCode(addr);
      if (liveCode === "0x") {
        console.log("  INCONCLUSIVE: no contract code at this address");
        results.push({ ...t, status: "INCONCLUSIVE", detail: "no code at address" });
        console.log("");
        continue;
      }
      const liveStripped = stripMetadata(liveCode);
      const v = verdict(liveStripped, ref, t.key);
      console.log(`  Live runtime bytecode length: ${liveCode.length} chars (stripped: ${liveStripped.length})`);
      console.log(`  Result: ${v.status} -- ${v.detail}`);
      results.push({ ...t, status: v.status, detail: v.detail, addr });
    } catch (e) {
      const reason = e?.shortMessage || e?.message || String(e);
      console.log(`  INCONCLUSIVE: RPC read failed -- ${reason}`);
      results.push({ ...t, status: "INCONCLUSIVE", detail: reason });
    }
    console.log("");
  }

  console.log("=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  for (const r of results) {
    console.log(`${r.label.padEnd(18)} ${r.status.padEnd(14)} ${r.detail || ""}`);
  }
  console.log("");
  console.log("Reminder: this script did not deploy, send, or modify anything.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
