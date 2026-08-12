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
 * METHOD: `contracts/verification/bytecode-reference-solc-0.8.24-exact.json`
 * holds pre-computed runtime bytecode for both source versions of all three
 * contracts, deployed locally (Hardhat's in-memory network) with the SAME
 * constructor identity values as the real production deployments, compiled
 * with the EXACT solc 0.8.24 pinned in hardhat.config.js (solc@0.8.24 from
 * the npm registry -- verified via `solc.version()`, stored in the
 * reference file). "old" == the source at commit 5f42045, the pre-Ultrafuzz
 * baseline every currently-live deploy record in this repo traces back to.
 * "new" == this branch's HEAD.
 *
 * COMPILER VERSION: previously this comparison used solc 0.8.26 (a prior
 * version of this file/reference), because this sandbox cannot reach
 * binaries.soliditylang.org (Hardhat's own compiler downloader). That
 * caveat is RESOLVED: solc 0.8.24 -- the exact version hardhat.config.js
 * pins -- was obtained from the npm registry (registry.npmjs.org, reachable
 * even though binaries.soliditylang.org is not) as the `solc@0.8.24` npm
 * package, confirmed via `solc.version()` to report
 * "0.8.24+commit.e11b9ed9.Emscripten.clang". The reference bytecode was
 * regenerated with it, using the ORIGINAL unmodified source text (no pragma
 * relaxation needed now that the compiler matches exactly) and the SAME
 * optimizer settings hardhat.config.js specifies (enabled: true, runs: 200)
 * with no other settings overridden -- evmVersion, viaIR, and metadata
 * settings are all left unset on both sides, so solc's own built-in
 * defaults for 0.8.24 apply identically to the reference build and to
 * whatever originally deployed the live contracts.
 *
 * Even with an exact compiler match, the comparison below strips Solidity's
 * CBOR metadata trailer before comparing (see stripMetadata()). That
 * trailer encodes a hash of the exact source file PATHS as compiled (e.g.
 * "contracts/PaymentExecutor.sol" under Hardhat's project layout vs. the
 * bare "PaymentExecutor.sol" used to compile the reference here) -- a
 * cosmetic difference in how the sources were labeled during compilation,
 * unrelated to the actual logic. Stripping it means the comparison is over
 * EXECUTABLE OPCODES ONLY, produced by the exact same compiler version and
 * exact same optimizer settings from the exact same source text. A PASS
 * here is as rigorous as bytecode verification gets without the original
 * deployer's exact solc invocation metadata.
 *
 * CONSTRUCTOR ARGS / IMMUTABLES -- can they cause a false mismatch?
 *   PaymentExecutor:  only `merchantRegistry` is `immutable` (baked into
 *     bytecode as a constant). owner/agent/dailyCap/maxTxAmount/
 *     dailyCapNative/maxTxAmountNative are all plain mutable storage
 *     (SSTORE'd in the constructor body) and do NOT affect bytecode at
 *     all. The reference was built with the real production registry
 *     address (0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb), so this is a
 *     non-issue: no immutable-related mismatch is possible here.
 *   AutomationVault:  NO immutable variables whatsoever -- owner and the
 *     isAgent mapping are both plain mutable storage. Constructor args
 *     (owner, agent) cannot affect runtime bytecode under ANY values.
 *   MerchantRegistry: no constructor parameters at all; owner = msg.sender
 *     is plain mutable storage. Deployer identity cannot affect bytecode.
 *   In short: for all three contracts, a PASS/FAIL result from this script
 *   is driven entirely by SOURCE CODE differences, never by which
 *   constructor values were used to produce the reference.
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
 * PASS  = exact opcode-level bytecode match against a known reference.
 * FAIL  = definite mismatch against BOTH known references (live contract
 *         is neither the old nor the new known source).
 * INCONCLUSIVE = could not obtain the data needed to compare at all (no
 *         code at the address, RPC failure, env var missing).
 */
function verdict(liveStripped, oldStripped, newStripped) {
  const live = liveStripped.replace(/^0x/, "");
  const old = oldStripped.replace(/^0x/, "");
  const nw = newStripped.replace(/^0x/, "");
  if (live === old) return { status: "PASS", detail: "matches OLD (pre-fix) source exactly" };
  if (live === nw) return { status: "PASS", detail: "matches NEW (fixed) source exactly" };
  return { status: "FAIL", detail: "matches neither known reference" };
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
  console.log(`Exact compiler match with hardhat.config.js's pinned 0.8.24: ${ref.exactCompilerMatch ? "YES" : "NO -- see file header caveat"}`);
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
      const oldStripped = ref[`${t.key}_old`].strippedCode;
      const newStripped = ref[`${t.key}_new`].strippedCode;
      const v = verdict(liveStripped, oldStripped, newStripped);
      console.log(`  Live runtime bytecode length: ${liveCode.length} chars`);
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
