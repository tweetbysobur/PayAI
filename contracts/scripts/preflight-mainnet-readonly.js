const hre = require("hardhat");

/**
 * READ-ONLY Monad mainnet pre-flight report for the PaymentExecutor/
 * AutomationVault cutover. See contracts/PRODUCTION_CUTOVER_PLAN.md for the
 * cutover plans this feeds into.
 *
 * SAFETY: this script makes ONLY `view`/`pure`/read-only `.call()`-style
 * queries via a standard JSON-RPC provider. It never constructs, signs, or
 * sends a transaction, and it requires NO private key -- there is nothing in
 * this file capable of modifying any contract's state. It is safe to run
 * against production mainnet by anyone with just an RPC URL.
 *
 * IMPORTANT: this script does NOT read contracts/deployed-*.json and does
 * NOT hardcode any address. Every contract address is taken from the SAME
 * env vars the live app itself reads (see lib/monad/config.ts) -- so the
 * accuracy of this report depends entirely on YOU providing the values
 * actually configured in Vercel's production environment right now, not
 * this repo's historical deploy records. If you're not certain an env var
 * below matches Vercel's current value, copy it from there first.
 *
 * Every reported fact is labeled:
 *   CONFIRMED ON-CHAIN  -- a successful, real read against the given address
 *                          on the RPC endpoint you pointed this at.
 *   NOT AVAILABLE        -- either the call reverted/failed (commonly means
 *                          the deployed contract doesn't have that function
 *                          -- e.g. querying totalReservedByToken() against
 *                          the CURRENT, pre-fix AutomationVault), or the
 *                          data structurally doesn't exist on any contract
 *                          (e.g. an enumerable list of reservations).
 *
 * Required env:
 *   MONAD_MAINNET_RPC              -- defaults to https://rpc.monad.xyz if unset,
 *                                     same as the app itself.
 *   MONAD_MAINNET_PAYMENT_EXECUTOR -- current production PaymentExecutor.
 *   MONAD_MAINNET_AUTOMATION_VAULT -- current production AutomationVault.
 *   MONAD_MAINNET_MERCHANT_REGISTRY-- current production MerchantRegistry.
 *   AGENT_ADDRESS                  -- the hot agent wallet's PUBLIC address
 *                                     only. Never provide a private key to
 *                                     this script -- it doesn't need one.
 * Optional:
 *   OWNER_ADDRESS                  -- cold wallet address, if known, to
 *                                     directly check its manager/role status
 *                                     rather than only reading owner().
 *   MONAD_MAINNET_USDC, MONAD_MAINNET_WMON, and any other ERC-20 addresses
 *     you want allowances checked for -- pass as a comma-separated
 *     TOKENS_TO_CHECK="0x...,0x...,..." (defaults to just MONAD_MAINNET_USDC
 *     if TOKENS_TO_CHECK is unset).
 *   MAX_REQUESTS_TO_SCAN (default 500) -- cap on how many PaymentExecutor
 *     requests to enumerate, in case requestsCount() is very large.
 *   MAX_MERCHANTS_TO_SCAN (default 500) -- same, for MerchantRegistry.
 *
 * Run with:
 *   cd contracts
 *   MONAD_MAINNET_RPC=... \
 *   MONAD_MAINNET_PAYMENT_EXECUTOR=0x... \
 *   MONAD_MAINNET_AUTOMATION_VAULT=0x... \
 *   MONAD_MAINNET_MERCHANT_REGISTRY=0x... \
 *   AGENT_ADDRESS=0x... \
 *   OWNER_ADDRESS=0x... \
 *   npx hardhat run scripts/preflight-mainnet-readonly.js --network monad
 *
 * No MONAD_AGENT_PRIVATE_KEY / PRIVATE_KEY needed -- despite hardhat.config.js
 * referencing them for the `monad` network's signer list, this script never
 * calls hre.ethers.getSigners() and never needs one.
 */

const CONFIRMED = (v) => `CONFIRMED ON-CHAIN: ${v}`;
const NOT_AVAILABLE = (why) => `NOT AVAILABLE${why ? " (" + why + ")" : ""}`;

/** Wraps a read call so one missing/reverting function never aborts the report.
 *  `note` is optional context printed alongside a NOT AVAILABLE result (e.g.
 *  "this is expected on a pre-fix contract"). */
async function tryRead(label, fn, note) {
  try {
    const v = await fn();
    console.log(`  ${label}: ${CONFIRMED(v)}`);
    return v;
  } catch (e) {
    const reason = e?.shortMessage || e?.message || String(e);
    console.log(`  ${label}: ${NOT_AVAILABLE(reason.slice(0, 120))}`);
    if (note) console.log(`    ${note}`);
    return undefined;
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} -- see this script's header comment for the full list.`);
  return v;
}

async function main() {
  const executorAddr = requireEnv("MONAD_MAINNET_PAYMENT_EXECUTOR");
  const vaultAddr = requireEnv("MONAD_MAINNET_AUTOMATION_VAULT");
  const registryAddr = requireEnv("MONAD_MAINNET_MERCHANT_REGISTRY");
  const agentAddr = requireEnv("AGENT_ADDRESS");
  const ownerAddrHint = process.env.OWNER_ADDRESS || null;
  const tokens = (process.env.TOKENS_TO_CHECK || process.env.MONAD_MAINNET_USDC || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const maxRequests = Number(process.env.MAX_REQUESTS_TO_SCAN ?? "500");
  const maxMerchants = Number(process.env.MAX_MERCHANTS_TO_SCAN ?? "500");

  console.log("=".repeat(78));
  console.log("READ-ONLY MAINNET PRE-FLIGHT REPORT");
  console.log("=".repeat(78));
  console.log("Network:  ", hre.network.name, `(chainId ${hre.network.config.chainId})`);
  console.log("RPC:      ", hre.network.config.url);
  console.log("Generated:", new Date().toISOString());
  console.log("\nInput addresses (YOU are responsible for these matching Vercel's current env):");
  console.log("  PaymentExecutor:  ", executorAddr);
  console.log("  AutomationVault:  ", vaultAddr);
  console.log("  MerchantRegistry: ", registryAddr);
  console.log("  Agent:            ", agentAddr);
  console.log("  Owner (hint):     ", ownerAddrHint ?? "(not provided -- will read owner() from each contract instead)");

  const provider = hre.ethers.provider;

  // Confirm these are actually contracts, not EOAs / typos, before anything else.
  console.log("\n--- 0. Sanity: is each address actually a contract? ---");
  for (const [label, addr] of [["PaymentExecutor", executorAddr], ["AutomationVault", vaultAddr], ["MerchantRegistry", registryAddr]]) {
    await tryRead(`${label} has contract code`, async () => {
      const code = await provider.getCode(addr);
      if (code === "0x") throw new Error("no code at this address -- not a contract, or wrong network");
      return `${(code.length - 2) / 2} bytes of runtime bytecode present`;
    });
  }

  const executor = await hre.ethers.getContractAt("PaymentExecutor", executorAddr);
  const vault = await hre.ethers.getContractAt("AutomationVault", vaultAddr);
  const registry = await hre.ethers.getContractAt("MerchantRegistry", registryAddr);

  console.log("\n--- 1-3. Addresses (echoed back; see caveat in header) ---");
  console.log("  See 'Input addresses' above -- these three items are report INPUTS, not on-chain reads.");
  console.log("  Whether they truly match Vercel's live env is on you to confirm before trusting anything below.");

  console.log("\n--- 4. Owner addresses ---");
  const executorOwner = await tryRead("PaymentExecutor.owner()", () => executor.owner());
  const vaultOwner = await tryRead("AutomationVault.owner()", () => vault.owner());
  const registryOwner = await tryRead("MerchantRegistry.owner()", () => registry.owner());

  console.log("\n--- 5. Agent / recorder / manager / registrar roles ---");
  await tryRead(`PaymentExecutor.isAgent(${agentAddr})`, () => executor.isAgent(agentAddr));
  await tryRead(`AutomationVault.isAgent(${agentAddr})`, () => vault.isAgent(agentAddr));
  await tryRead(`MerchantRegistry.isManager(${agentAddr})`, () => registry.isManager(agentAddr));
  await tryRead(`MerchantRegistry.isRegistrar(${agentAddr})`, () => registry.isRegistrar(agentAddr),
    "-- expected NOT AVAILABLE if the deployed registry predates the L-02 fix (no such role yet)");
  await tryRead(`MerchantRegistry.isRecorder(${executorAddr}) -- is the CURRENT executor actually wired up?`, () => registry.isRecorder(executorAddr));
  if (ownerAddrHint) {
    await tryRead(`MerchantRegistry.isManager(${ownerAddrHint})`, () => registry.isManager(ownerAddrHint));
  }
  await tryRead("PaymentExecutor.paused()", () => executor.paused());
  await tryRead("AutomationVault.paused()", () => vault.paused());

  console.log("\n--- 6. Active automation count ---");
  console.log("  NOT AVAILABLE -- Automations are tracked in PayAI's application database, not on any");
  console.log("  contract. No on-chain read can answer this. Requires production DB access.");

  console.log("\n--- 7. Active reservations and total reserved amounts ---");
  console.log("  Per-reservation detail is structurally NOT AVAILABLE: AutomationVault has no");
  console.log("  enumerable list of automationIds (mapping-only storage, no allReservations() view).");
  console.log("  What CAN be read -- the vault's raw aggregate holdings (upper bound on what's reserved,");
  console.log("  since the vault should hold nothing beyond active reservations):");
  await tryRead("  AutomationVault native MON balance", async () => hre.ethers.formatEther(await provider.getBalance(vaultAddr)) + " MON");
  for (const t of tokens) {
    await tryRead(`  AutomationVault balance of token ${t}`, async () => {
      const erc20 = new hre.ethers.Contract(t, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"], provider);
      const [bal, dec, sym] = await Promise.all([erc20.balanceOf(vaultAddr), erc20.decimals().catch(() => 18), erc20.symbol().catch(() => "?")]);
      return `${hre.ethers.formatUnits(bal, dec)} ${sym}`;
    });
    await tryRead(`  AutomationVault.totalReservedByToken(${t})`, () => vault.totalReservedByToken(t),
      "-- expected NOT AVAILABLE unless M-01 is already deployed; if this SUCCEEDS, the fix may already be live");
  }

  console.log("\n--- 8. Pending payment requests ---");
  const requestsCount = await tryRead("PaymentExecutor.requestsCount()", () => executor.requestsCount());
  if (requestsCount !== undefined) {
    const n = Number(requestsCount);
    const scanLimit = Math.min(n, maxRequests);
    if (n > maxRequests) console.log(`  NOTE: ${n} total requests, only scanning the first ${maxRequests} (raise MAX_REQUESTS_TO_SCAN to scan more).`);
    let pending = 0;
    for (let i = 0; i < scanLimit; i++) {
      try {
        const r = await executor.getRequest(i);
        if (!r.paid) pending++;
      } catch { /* skip unreadable entries, don't abort the scan */ }
    }
    console.log(`  Pending (paid == false) among scanned: ${CONFIRMED(pending + " of " + scanLimit + " scanned")}`);
  }

  console.log("\n--- 9. ERC-20 allowances to PaymentExecutor from the agent ---");
  if (tokens.length === 0) {
    console.log("  NOT AVAILABLE -- no TOKENS_TO_CHECK / MONAD_MAINNET_USDC provided.");
  }
  for (const t of tokens) {
    await tryRead(`  allowance(agent -> executor) for token ${t}`, async () => {
      const erc20 = new hre.ethers.Contract(t, ["function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"], provider);
      const [a, dec, sym] = await Promise.all([erc20.allowance(agentAddr, executorAddr), erc20.decimals().catch(() => 18), erc20.symbol().catch(() => "?")]);
      return `${hre.ethers.formatUnits(a, dec)} ${sym}`;
    });
  }

  console.log("\n--- 10. Current global vault/executor configuration ---");
  await tryRead("PaymentExecutor.dailyCap()", () => executor.dailyCap());
  await tryRead("PaymentExecutor.maxTxAmount()", () => executor.maxTxAmount());
  await tryRead("PaymentExecutor.dailyCapNative()", () => executor.dailyCapNative());
  await tryRead("PaymentExecutor.maxTxAmountNative()", () => executor.maxTxAmountNative());

  console.log("\n--- 11. Other state a redeploy would affect ---");
  await tryRead("PaymentExecutor.totalVolume()", () => executor.totalVolume());
  await tryRead("PaymentExecutor.approvedCount()", () => executor.approvedCount());
  await tryRead("PaymentExecutor.rejectedCount()", () => executor.rejectedCount());
  await tryRead("PaymentExecutor.paymentsCount()", () => executor.paymentsCount());
  const today = Math.floor(Date.now() / 1000 / 86400);
  await tryRead(`PaymentExecutor.spentPerDay(agent, today=${today})`, () => executor.spentPerDay(agentAddr, today));
  await tryRead(`PaymentExecutor.spentPerDayNative(agent, today=${today})`, () => executor.spentPerDayNative(agentAddr, today));

  console.log("\n  Registered merchants and any custom caps (comprehensive -- MerchantRegistry IS enumerable):");
  const merchantCount = await tryRead("  MerchantRegistry.merchantCount()", () => registry.merchantCount());
  if (merchantCount !== undefined) {
    const n = Number(merchantCount);
    const scanLimit = Math.min(n, maxMerchants);
    if (n > maxMerchants) console.log(`  NOTE: ${n} total merchants, only scanning the first ${maxMerchants} (raise MAX_MERCHANTS_TO_SCAN to scan more).`);
    let inactive = 0, withCustomCap = 0;
    for (let i = 0; i < scanLimit; i++) {
      try {
        const addr = await registry.merchantAt(i);
        const m = await registry.getMerchant(addr);
        if (!m.active) inactive++;
        const cap = await executor.merchantMaxTx(addr).catch(() => 0n);
        if (cap > 0n) withCustomCap++;
      } catch { /* skip, don't abort */ }
    }
    console.log(`  Inactive merchants among scanned: ${CONFIRMED(inactive + " of " + scanLimit)}`);
    console.log(`  Merchants with a custom PaymentExecutor cap among scanned: ${CONFIRMED(withCustomCap + " of " + scanLimit)}`);
  }

  console.log("\n" + "=".repeat(78));
  console.log("End of report. Nothing was written to any contract -- every call above was");
  console.log("a read-only RPC query. See this report's output plus");
  console.log("contracts/PRODUCTION_CUTOVER_PLAN.md before deciding anything.");
  console.log("=".repeat(78));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
