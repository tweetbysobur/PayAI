const hre = require("hardhat");

/**
 * READ-ONLY investigation of AutomationVault's actual ERC-20 custody vs. its
 * own reservation ledger, for the production cutover pre-flight. Answers:
 * does every token unit sitting in the vault belong to a specific, still-open
 * reservation (recoverable any time via release()/refund(), no code change
 * needed), or is some of it untracked dust no reservation claims?
 *
 * WHY THIS IS NEEDED: `AutomationVault.reservations` is a
 * `mapping(bytes32 => Reservation)` with no enumerable key list (see
 * contracts/PRODUCTION_CUTOVER_PLAN.md section 2a) -- there is no on-chain
 * view that lists "every reservation." The only way to reconstruct which
 * automationId(s) a given token balance belongs to is replaying this
 * contract's own Reserved/Released/Refunded events and netting them out per
 * automationId, then cross-checking each nonzero result against the live
 * reservedBalance()/reservations() view (the source of truth) and against
 * totalReservedByToken() where available (post-M-01 contracts only).
 *
 * SAFETY: read-only. Only eth_getLogs and view-function calls via a plain
 * JSON-RPC provider. No signer, no private key, no transaction.
 *
 * Required env:
 *   MONAD_MAINNET_AUTOMATION_VAULT
 * Optional:
 *   MONAD_MAINNET_RPC       -- defaults to https://rpc.monad.xyz
 *   TOKEN_TO_CHECK          -- ERC-20 address to net out; defaults to
 *                              MONAD_MAINNET_USDC. Use "native" (or leave
 *                              unset with no USDC env either) to check MON.
 *   FROM_BLOCK              -- defaults to 0. Set to the vault's actual
 *                              deployment block if known, to speed up the
 *                              scan and avoid RPC log-range limits.
 *   LOG_CHUNK_BLOCKS        -- block window per getLogs call when the RPC
 *                              rejects an unbounded range (default 5000).
 *
 * Run with (from contracts/):
 *   npx hardhat run scripts/investigate-vault-reservation-readonly.js --network monad
 */

const VAULT_ABI = [
  "event Reserved(bytes32 indexed automationId, address indexed depositor, address token, address recipient, uint256 amount, uint256 newBalance)",
  "event Released(bytes32 indexed automationId, address indexed recipient, address token, uint256 amount, uint256 remaining, bytes32 requestId)",
  "event Refunded(bytes32 indexed automationId, address indexed depositor, address token, uint256 amount)",
  "function reservations(bytes32) view returns (address depositor, address token, address recipient, uint256 balance, bool exists)",
  "function reservedBalance(bytes32) view returns (uint256)",
  "function totalReservedByToken(address) view returns (uint256)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];

async function getLogsChunked(provider, filter, fromBlock, toBlock, chunkSize) {
  const logs = [];
  try {
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (e) {
    console.log(`  (single-range query failed -- ${e?.shortMessage || e?.message}; falling back to chunked scan of ${chunkSize} blocks at a time)`);
  }
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const chunk = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
    logs.push(...chunk);
    if (chunk.length) console.log(`    blocks ${start}-${end}: ${chunk.length} log(s)`);
    start = end + 1;
  }
  return logs;
}

async function main() {
  const vaultAddr = process.env.MONAD_MAINNET_AUTOMATION_VAULT;
  if (!vaultAddr) throw new Error("Set MONAD_MAINNET_AUTOMATION_VAULT.");
  const rpcUrl = process.env.MONAD_MAINNET_RPC || "https://rpc.monad.xyz";
  const tokenAddr = process.env.TOKEN_TO_CHECK || process.env.MONAD_MAINNET_USDC;
  const isNative = !tokenAddr || tokenAddr.toLowerCase() === "native";
  const fromBlock = Number(process.env.FROM_BLOCK ?? 0);
  const chunkSize = Number(process.env.LOG_CHUNK_BLOCKS ?? 5000);

  const provider = new hre.ethers.JsonRpcProvider(rpcUrl, { chainId: 143, name: "monad" });
  const vault = new hre.ethers.Contract(vaultAddr, VAULT_ABI, provider);

  const latest = await provider.getBlockNumber();
  console.log("=".repeat(70));
  console.log("READ-ONLY VAULT RESERVATION INVESTIGATION");
  console.log("=".repeat(70));
  console.log(`Vault:         ${vaultAddr}`);
  console.log(`Token checked: ${isNative ? "native MON" : tokenAddr}`);
  console.log(`Block range:   ${fromBlock} .. ${latest}`);
  console.log("");

  // Ground truth: real custody right now.
  let realCustody;
  let decimals = 18, symbol = isNative ? "MON" : "TOKEN";
  if (isNative) {
    realCustody = await provider.getBalance(vaultAddr);
  } else {
    const token = new hre.ethers.Contract(tokenAddr, ERC20_ABI, provider);
    realCustody = await token.balanceOf(vaultAddr);
    try { decimals = Number(await token.decimals()); } catch {}
    try { symbol = await token.symbol(); } catch {}
  }
  console.log(`Real custody (balanceOf/balance) right now: ${hre.ethers.formatUnits(realCustody, decimals)} ${symbol}`);

  try {
    const tracked = await vault.totalReservedByToken(isNative ? hre.ethers.ZeroAddress : tokenAddr);
    console.log(`totalReservedByToken() (post-M-01 only):    CONFIRMED ON-CHAIN: ${hre.ethers.formatUnits(tracked, decimals)} ${symbol}`);
  } catch (e) {
    console.log(`totalReservedByToken(): NOT AVAILABLE (${e?.shortMessage || e?.message}) -- expected on a pre-M-01 contract, this function doesn't exist there.`);
  }
  console.log("");

  console.log("Replaying Reserved / Released / Refunded events...");
  const [reservedLogs, releasedLogs, refundedLogs] = await Promise.all([
    getLogsChunked(provider, { address: vaultAddr, topics: [vault.interface.getEvent("Reserved").topicHash] }, fromBlock, latest, chunkSize),
    getLogsChunked(provider, { address: vaultAddr, topics: [vault.interface.getEvent("Released").topicHash] }, fromBlock, latest, chunkSize),
    getLogsChunked(provider, { address: vaultAddr, topics: [vault.interface.getEvent("Refunded").topicHash] }, fromBlock, latest, chunkSize),
  ]);
  console.log(`  Reserved: ${reservedLogs.length} event(s), Released: ${releasedLogs.length}, Refunded: ${refundedLogs.length}`);
  console.log("");

  const targetToken = isNative ? hre.ethers.ZeroAddress : hre.ethers.getAddress(tokenAddr);
  const net = new Map(); // automationId => { net: bigint, depositor, recipient }

  for (const log of reservedLogs) {
    const ev = vault.interface.parseLog(log);
    if (ev.args.token.toLowerCase() !== targetToken.toLowerCase()) continue;
    const id = ev.args.automationId;
    const prev = net.get(id) || { net: 0n, depositor: ev.args.depositor, recipient: ev.args.recipient };
    prev.net += ev.args.amount;
    net.set(id, prev);
  }
  for (const log of releasedLogs) {
    const ev = vault.interface.parseLog(log);
    if (ev.args.token.toLowerCase() !== targetToken.toLowerCase()) continue;
    const id = ev.args.automationId;
    const prev = net.get(id);
    if (prev) prev.net -= ev.args.amount;
  }
  for (const log of refundedLogs) {
    const ev = vault.interface.parseLog(log);
    if (ev.args.token.toLowerCase() !== targetToken.toLowerCase()) continue;
    const id = ev.args.automationId;
    const prev = net.get(id);
    if (prev) prev.net = 0n; // refund always drains the full remaining balance
  }

  const active = [...net.entries()].filter(([, v]) => v.net > 0n);
  console.log(`Reservations netting to a nonzero balance for this token: ${active.length}`);

  let sumFromEvents = 0n;
  for (const [id, v] of active) {
    let liveBalance = "NOT AVAILABLE";
    try {
      liveBalance = hre.ethers.formatUnits(await vault.reservedBalance(id), decimals);
    } catch (e) {
      liveBalance = `NOT AVAILABLE (${e?.shortMessage || e?.message})`;
    }
    sumFromEvents += v.net;
    console.log(`  automationId ${id}`);
    console.log(`    depositor: ${v.depositor}  recipient: ${v.recipient}`);
    console.log(`    net from event replay: ${hre.ethers.formatUnits(v.net, decimals)} ${symbol}`);
    console.log(`    live reservedBalance(): ${liveBalance} ${symbol}  ${liveBalance !== "NOT AVAILABLE" && liveBalance === hre.ethers.formatUnits(v.net, decimals) ? "(MATCHES event replay -- CONFIRMED ON-CHAIN)" : ""}`);
  }
  console.log("");

  console.log("=".repeat(70));
  console.log("VERDICT");
  console.log("=".repeat(70));
  const realStr = hre.ethers.formatUnits(realCustody, decimals);
  const trackedStr = hre.ethers.formatUnits(sumFromEvents, decimals);
  console.log(`Real custody:                    ${realStr} ${symbol}`);
  console.log(`Sum of open reservations found:  ${trackedStr} ${symbol}`);
  if (sumFromEvents === realCustody) {
    console.log("PASS: every unit of real custody is accounted for by an open reservation above.");
    console.log("      Recovery mechanism: call release() or refund() on THIS vault address for the");
    console.log("      automationId(s) listed above -- both remain fully callable indefinitely,");
    console.log("      independent of any new AutomationVault being deployed. Not stranded.");
  } else if (sumFromEvents < realCustody) {
    const untracked = realCustody - sumFromEvents;
    console.log(`WARNING: ${hre.ethers.formatUnits(untracked, decimals)} ${symbol} of real custody does NOT correspond`);
    console.log("      to any open reservation found by replaying events in the scanned block range.");
    console.log("      Possible causes: (a) a direct/raw token transfer to the vault address that never");
    console.log("      went through reserve() -- this contract has no sweep/rescue function, so such dust");
    console.log("      would remain unreachable through any vault function, old or new; (b) FROM_BLOCK was");
    console.log("      set later than the vault's actual deployment block, missing earlier events -- rerun");
    console.log("      with FROM_BLOCK=0 (default) or the vault's true deployment block to rule this out.");
  } else {
    console.log("WARNING: sum of open reservations EXCEEDS real custody -- investigate before proceeding.");
    console.log("      This would indicate either missed events (RPC log gaps) or an already-insolvent token.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
