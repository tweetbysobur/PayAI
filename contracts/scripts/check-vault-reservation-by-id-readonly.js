const hre = require("hardhat");

/**
 * READ-ONLY, O(candidates) alternative to the full event-log replay in
 * investigate-vault-reservation-readonly.js. Checks specific automationId
 * candidates directly against AutomationVault's reservations()/
 * reservedBalance() views -- no eth_getLogs, no block scanning, no rate
 * limit exposure at all.
 *
 * WHY THIS EXISTS: a full log replay from AutomationVault's deployment
 * block to now spans ~9 million blocks on Monad (~90,000 windows even at
 * the RPC's 100-block-per-request cap), estimated ~75+ minutes minimum at a
 * safe rate limit. That's only needed because `reservations` is a
 * `mapping(bytes32 => Reservation)` with no enumerable key list -- if you
 * already know (or can narrow to a short list of) which automationId(s)
 * might hold the balance, you can query them directly in O(1) each instead.
 *
 * WHERE CANDIDATE AUTOMATION IDS COME FROM: PayAI's own production
 * database (NOT the blockchain) -- every `PaymentAutomation` record has a
 * `vaultAddress` field pinned at creation time (see
 * lib/platform/types.ts:193) and a `fundingMode: "reserved"` field. Filter
 * production automations where
 * `vaultAddress === "0x1b84c9Aa7E46b90d6e49422e1Cf18142AAD3FE0f"` (this old
 * vault) AND `fundingMode === "reserved"`, and collect their `.id` values --
 * that's a short list (likely a handful, not thousands), unlike replaying
 * every block since deployment. This script cannot query that database
 * itself (this sandbox has no access to it, and it's a separate credential
 * from RPC access anyway) -- pass the candidate id STRINGS you find via
 * CANDIDATE_AUTOMATION_IDS, and this script computes the same on-chain key
 * the app itself uses (see lib/monad/contracts.ts's `requestId32`):
 * `keccak256(stringToHex(id))` (viem) == `ethers.keccak256(ethers.toUtf8Bytes(id))`
 * (used here) -- byte-identical algorithm, just a different library.
 *
 * IF YOU DON'T HAVE DATABASE ACCESS: pass already-known bytes32 hashes
 * directly via CANDIDATE_AUTOMATION_ID_HASHES instead. If you have NEITHER
 * an id nor a hash for any candidate, there is no way to narrow the search
 * below a full event-log replay -- `investigate-vault-reservation-readonly.js`
 * with an accurate FROM_BLOCK remains the only fallback, and its ~9M-block
 * range as of this writing has no smaller justified sub-range: nothing in
 * this repository gives a MORE precise timestamp than the vault's own
 * deployment record for when any specific reserve() call happened, so
 * narrowing further would be guessing, which this script deliberately does
 * not do.
 *
 * SAFETY: read-only. Only view-function calls (reservations, reservedBalance,
 * balanceOf, decimals, symbol) via a plain JSON-RPC provider. No signer, no
 * private key, no transaction, no state change of any kind.
 *
 * Required env:
 *   MONAD_MAINNET_AUTOMATION_VAULT
 *   At least one of:
 *     CANDIDATE_AUTOMATION_IDS       -- comma-separated app-level id strings
 *     CANDIDATE_AUTOMATION_ID_HASHES -- comma-separated bytes32 hex hashes
 * Optional:
 *   MONAD_MAINNET_RPC   -- defaults to https://rpc.monad.xyz
 *   MONAD_MAINNET_USDC  -- defaults to 0x754704Bc059F8C67012fEd69BC8A327a5aafb603
 *                          (the configured production USDC address given for
 *                          this investigation -- explicitly checked, never
 *                          assumed to be native MON).
 *
 * Run with (from contracts/):
 *   npx hardhat run scripts/check-vault-reservation-by-id-readonly.js --network monad
 */

const VAULT_ABI = [
  "function reservations(bytes32) view returns (address depositor, address token, address recipient, uint256 balance, bool exists)",
  "function reservedBalance(bytes32) view returns (uint256)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];

async function main() {
  const vaultAddr = process.env.MONAD_MAINNET_AUTOMATION_VAULT;
  if (!vaultAddr) throw new Error("Set MONAD_MAINNET_AUTOMATION_VAULT.");
  const rpcUrl = process.env.MONAD_MAINNET_RPC || "https://rpc.monad.xyz";
  const usdcAddr = process.env.MONAD_MAINNET_USDC || "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

  const idsRaw = process.env.CANDIDATE_AUTOMATION_IDS || "";
  const hashesRaw = process.env.CANDIDATE_AUTOMATION_ID_HASHES || "";
  if (!idsRaw && !hashesRaw) {
    throw new Error(
      "Set CANDIDATE_AUTOMATION_IDS (comma-separated app-level automation id strings, from the " +
        "production DB) and/or CANDIDATE_AUTOMATION_ID_HASHES (already-computed bytes32 keys). " +
        "See this script's header comment for where to find candidates.",
    );
  }

  const provider = new hre.ethers.JsonRpcProvider(rpcUrl, { chainId: 143, name: "monad" });
  const vault = new hre.ethers.Contract(vaultAddr, VAULT_ABI, provider);
  const token = new hre.ethers.Contract(usdcAddr, ERC20_ABI, provider);

  let decimals = 6;
  let symbol = "USDC";
  try { decimals = Number(await token.decimals()); } catch {}
  try { symbol = await token.symbol(); } catch {}

  const realCustody = await token.balanceOf(vaultAddr);

  console.log("=".repeat(70));
  console.log("READ-ONLY DIRECT RESERVATION LOOKUP (no log scanning)");
  console.log("=".repeat(70));
  console.log(`Vault:                ${vaultAddr}`);
  console.log(`Token checked (USDC): ${usdcAddr}`);
  console.log(`Real custody (balanceOf) right now: ${hre.ethers.formatUnits(realCustody, decimals)} ${symbol}`);
  console.log("");

  const candidates = [];
  for (const id of idsRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    candidates.push({ label: `app automation id "${id}"`, hash: hre.ethers.keccak256(hre.ethers.toUtf8Bytes(id)) });
  }
  for (const h of hashesRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    candidates.push({ label: `given hash ${h}`, hash: h });
  }
  if (candidates.length === 0) {
    throw new Error("CANDIDATE_AUTOMATION_IDS / CANDIDATE_AUTOMATION_ID_HASHES were set but produced zero usable entries.");
  }

  console.log(`Checking ${candidates.length} candidate automationId(s) directly -- zero eth_getLogs calls.`);
  console.log("");

  let sumMatched = 0n;
  const matched = [];
  for (const c of candidates) {
    const r = await vault.reservations(c.hash);
    console.log(`${c.label}`);
    console.log(`  on-chain key: ${c.hash}`);
    console.log(`  exists: ${r.exists}  depositor: ${r.depositor}  token: ${r.token}  recipient: ${r.recipient}`);
    console.log(`  balance: ${hre.ethers.formatUnits(r.balance, decimals)} ${symbol} (raw ${r.balance})`);
    const isTargetToken = r.token.toLowerCase() === usdcAddr.toLowerCase();
    if (r.exists && isTargetToken && r.balance > 0n) {
      matched.push({ ...c, balance: r.balance, depositor: r.depositor, recipient: r.recipient });
      sumMatched += r.balance;
      console.log("  -> MATCHES the configured USDC token with a nonzero balance.");
    } else if (r.exists && r.balance > 0n && !isTargetToken) {
      console.log(`  -> exists with a balance, but token is ${r.token}, NOT the checked USDC address -- not counted.`);
    }
    console.log("");
  }

  console.log("=".repeat(70));
  console.log("VERDICT");
  console.log("=".repeat(70));
  const realStr = hre.ethers.formatUnits(realCustody, decimals);
  const matchedStr = hre.ethers.formatUnits(sumMatched, decimals);
  console.log(`Real custody:              ${realStr} ${symbol}`);
  console.log(`Sum matched by candidates: ${matchedStr} ${symbol}`);
  console.log("");

  if (matched.length > 0 && sumMatched === realCustody) {
    console.log("CLASSIFICATION: ACTIVE RESERVATION -- CONFIRMED ON-CHAIN via direct reservations() lookup.");
    for (const m of matched) {
      console.log(`  ${m.label} accounts for ${hre.ethers.formatUnits(m.balance, decimals)} ${symbol}`);
      console.log(`    depositor: ${m.depositor}  recipient: ${m.recipient}`);
    }
    console.log("  Recovery mechanism: call release() or refund() on THIS vault address for the");
    console.log("  automationId(s) above -- both remain fully callable indefinitely, independent of");
    console.log("  any new AutomationVault being deployed. Not stranded.");
  } else if (sumMatched > 0n && sumMatched < realCustody) {
    console.log("CLASSIFICATION: PARTIAL MATCH -- some custody is confirmed ACTIVE RESERVATION, but");
    console.log(`  ${hre.ethers.formatUnits(realCustody - sumMatched, decimals)} ${symbol} remains unaccounted for.`);
    console.log("  Either the candidate list is incomplete (more reserved automations exist for this");
    console.log("  vault that weren't included), or the remainder is untracked dust. Cannot classify");
    console.log("  the remainder without either a fuller candidate list or a full log replay.");
  } else {
    console.log("CLASSIFICATION: INCONCLUSIVE from this candidate list -- none of the checked");
    console.log("  automationIds hold a matching nonzero USDC balance in this vault.");
    console.log("  This does NOT prove the 0.1 USDC is untracked dust -- it only means none of the");
    console.log("  SPECIFIC candidates checked here account for it. Either the candidate list from the");
    console.log("  production database was incomplete, or a full event-log replay");
    console.log("  (investigate-vault-reservation-readonly.js) is needed to be conclusive.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
