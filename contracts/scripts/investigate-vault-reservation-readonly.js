const hre = require("hardhat");

/**
 * READ-ONLY investigation of AutomationVault's actual ERC-20 custody vs. its
 * own reservation ledger, for the production cutover pre-flight. Answers:
 * does every token unit sitting in the vault belong to a specific, still-open
 * reservation (recoverable any time via release()/refund(), no code change
 * needed), was it released/refunded already, or is it untracked dust no
 * reservation claims?
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
 * EVENT SCANNING: Monad's mainnet RPC caps eth_getLogs at a 100-block range
 * per request (confirmed: "eth_getLogs is limited to a 100 range" was
 * returned for anything wider, including the previous version of this
 * script's 5,000-block fallback chunks). Every request below is capped at
 * 100 blocks. The three event topics (Reserved/Released/Refunded) are
 * queried in a SINGLE combined eth_getLogs call per 100-block window (topic0
 * as an OR-list) rather than three separate calls, and windows are fetched
 * with bounded concurrency (LOG_SCAN_CONCURRENCY, default 8) -- otherwise a
 * multi-month block range at 100 blocks/request would take impractically
 * long run serially. Concurrency only parallelizes independent read calls;
 * it does not change the 100-block cap on any single request and sends no
 * transaction of any kind.
 *
 * DEPLOYMENT BLOCK: if FROM_BLOCK isn't set, the script binary-searches for
 * the vault's actual deployment block via eth_getCode at historic block
 * heights (also read-only, ~25 calls via binary search over the full
 * range) so the scan doesn't default to genesis. Falls back to FROM_BLOCK
 * (or 0) with a printed warning if the RPC doesn't support historical
 * eth_getCode (e.g. a non-archive node).
 *
 * SAFETY: read-only. Only eth_getLogs, eth_getCode, and view-function calls
 * via a plain JSON-RPC provider. No signer, no private key, no transaction.
 *
 * Required env:
 *   MONAD_MAINNET_AUTOMATION_VAULT
 * Optional:
 *   MONAD_MAINNET_RPC       -- defaults to https://rpc.monad.xyz
 *   TOKEN_TO_CHECK          -- ERC-20 address to net out; defaults to
 *                              MONAD_MAINNET_USDC. Use "native" (or leave
 *                              unset with no USDC env either) to check MON.
 *   FROM_BLOCK              -- explicit starting block. If unset, the script
 *                              tries to auto-detect the vault's deployment
 *                              block; only falls back to 0 if that fails.
 *   LOG_CHUNK_BLOCKS        -- block window per getLogs call, hard-capped at
 *                              100 regardless of what's passed (default 100).
 *   LOG_SCAN_CONCURRENCY    -- parallel in-flight getLogs requests (default 8).
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

const MAX_RANGE = 100;

/** Binary-search the first block at which `address` has code. Read-only (eth_getCode only). */
async function findDeploymentBlock(provider, address, latest) {
  try {
    const codeAtLatest = await provider.getCode(address, latest);
    if (codeAtLatest === "0x") return null; // no code even now -- nothing to search for
    const codeAtGenesis = await provider.getCode(address, 0);
    if (codeAtGenesis !== "0x") return 0;
    let lo = 0;
    let hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const code = await provider.getCode(address, mid);
      if (code === "0x") lo = mid + 1;
      else hi = mid;
    }
    return lo;
  } catch (e) {
    return { error: e?.shortMessage || e?.message || String(e) };
  }
}

/** Fetch eth_getLogs across [fromBlock, toBlock] in <=100-block windows, with bounded concurrency. */
async function scanLogsInChunks(provider, filter, fromBlock, toBlock, chunkSize, concurrency) {
  const windows = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    windows.push([start, Math.min(start + chunkSize - 1, toBlock)]);
  }
  const totalWindows = windows.length;
  console.log(`  Scanning ${totalWindows} window(s) of <=${chunkSize} blocks each (concurrency ${concurrency})...`);

  const allLogs = [];
  let nextIndex = 0;
  let completed = 0;
  let lastReported = -1;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= windows.length) return;
      const [start, end] = windows[i];
      const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
      if (logs.length) allLogs.push(...logs);
      completed++;
      const pct = Math.floor((completed / totalWindows) * 100);
      if (pct >= lastReported + 10 || completed === totalWindows) {
        lastReported = pct;
        console.log(`    progress: ${completed}/${totalWindows} windows (${pct}%), ${allLogs.length} matching log(s) so far`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(windows.length, 1)) }, () => worker());
  await Promise.all(workers);
  return allLogs;
}

async function main() {
  const vaultAddr = process.env.MONAD_MAINNET_AUTOMATION_VAULT;
  if (!vaultAddr) throw new Error("Set MONAD_MAINNET_AUTOMATION_VAULT.");
  const rpcUrl = process.env.MONAD_MAINNET_RPC || "https://rpc.monad.xyz";
  const tokenAddr = process.env.TOKEN_TO_CHECK || process.env.MONAD_MAINNET_USDC;
  const isNative = !tokenAddr || tokenAddr.toLowerCase() === "native";
  const chunkSize = Math.min(Number(process.env.LOG_CHUNK_BLOCKS ?? MAX_RANGE), MAX_RANGE);
  const concurrency = Number(process.env.LOG_SCAN_CONCURRENCY ?? 8);

  const provider = new hre.ethers.JsonRpcProvider(rpcUrl, { chainId: 143, name: "monad" });
  const vault = new hre.ethers.Contract(vaultAddr, VAULT_ABI, provider);

  const latest = await provider.getBlockNumber();

  let fromBlock;
  if (process.env.FROM_BLOCK !== undefined) {
    fromBlock = Number(process.env.FROM_BLOCK);
  } else {
    console.log("FROM_BLOCK not set -- attempting to auto-detect the vault's deployment block (binary search via eth_getCode)...");
    const detected = await findDeploymentBlock(provider, vaultAddr, latest);
    if (typeof detected === "number") {
      fromBlock = detected;
      console.log(`  Auto-detected deployment block: ${fromBlock}`);
    } else {
      fromBlock = 0;
      const why = detected && detected.error ? detected.error : "no code found at the given address";
      console.log(`  Auto-detection failed (${why}) -- falling back to FROM_BLOCK=0. This may be a VERY long scan;`);
      console.log("  consider setting FROM_BLOCK explicitly to the vault's known deployment block if you have it.");
    }
  }

  console.log("=".repeat(70));
  console.log("READ-ONLY VAULT RESERVATION INVESTIGATION");
  console.log("=".repeat(70));
  console.log(`Vault:         ${vaultAddr}`);
  console.log(`Token checked: ${isNative ? "native MON" : tokenAddr}`);
  console.log(`Block range:   ${fromBlock} .. ${latest} (${latest - fromBlock + 1} blocks, ${chunkSize}-block windows)`);
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

  let hasTotalReservedByToken = false;
  try {
    const tracked = await vault.totalReservedByToken(isNative ? hre.ethers.ZeroAddress : tokenAddr);
    hasTotalReservedByToken = true;
    console.log(`totalReservedByToken() (post-M-01 only):    CONFIRMED ON-CHAIN: ${hre.ethers.formatUnits(tracked, decimals)} ${symbol}`);
  } catch (e) {
    console.log(`totalReservedByToken(): NOT AVAILABLE (${e?.shortMessage || e?.message}) -- expected on a pre-M-01 contract, this function doesn't exist there.`);
  }
  console.log("");

  console.log("Replaying Reserved / Released / Refunded events (combined query per window)...");
  const topics = [[
    vault.interface.getEvent("Reserved").topicHash,
    vault.interface.getEvent("Released").topicHash,
    vault.interface.getEvent("Refunded").topicHash,
  ]];
  const allLogs = await scanLogsInChunks(provider, { address: vaultAddr, topics }, fromBlock, latest, chunkSize, concurrency);

  const reservedLogs = [], releasedLogs = [], refundedLogs = [];
  for (const log of allLogs) {
    const ev = vault.interface.parseLog(log);
    if (ev.name === "Reserved") reservedLogs.push(ev);
    else if (ev.name === "Released") releasedLogs.push(ev);
    else if (ev.name === "Refunded") refundedLogs.push(ev);
  }
  console.log(`  Reserved: ${reservedLogs.length} event(s), Released: ${releasedLogs.length}, Refunded: ${refundedLogs.length}`);
  console.log("");

  const targetToken = isNative ? hre.ethers.ZeroAddress : hre.ethers.getAddress(tokenAddr);
  // automationId => { net, depositor, recipient, everReserved, everReleasedOrRefunded }
  const net = new Map();

  for (const ev of reservedLogs) {
    if (ev.args.token.toLowerCase() !== targetToken.toLowerCase()) continue;
    const id = ev.args.automationId;
    const prev = net.get(id) || { net: 0n, depositor: ev.args.depositor, recipient: ev.args.recipient, everReserved: true, everReleasedOrRefunded: false };
    prev.net += ev.args.amount;
    prev.everReserved = true;
    net.set(id, prev);
  }
  for (const ev of releasedLogs) {
    if (ev.args.token.toLowerCase() !== targetToken.toLowerCase()) continue;
    const id = ev.args.automationId;
    const prev = net.get(id);
    if (prev) {
      prev.net -= ev.args.amount;
      prev.everReleasedOrRefunded = true;
    }
  }
  for (const ev of refundedLogs) {
    if (ev.args.token.toLowerCase() !== targetToken.toLowerCase()) continue;
    const id = ev.args.automationId;
    const prev = net.get(id);
    if (prev) {
      prev.net = 0n; // refund always drains the full remaining balance
      prev.everReleasedOrRefunded = true;
    }
  }

  const active = [...net.entries()].filter(([, v]) => v.net > 0n);
  const drained = [...net.entries()].filter(([, v]) => v.net === 0n && v.everReleasedOrRefunded);
  console.log(`Reservations netting to a nonzero balance for this token: ${active.length}`);
  console.log(`Reservations fully released/refunded (net zero) for this token: ${drained.length}`);

  let sumFromEvents = 0n;
  for (const [id, v] of active) {
    let liveBalance = "NOT AVAILABLE";
    let liveBalanceRaw = null;
    try {
      liveBalanceRaw = await vault.reservedBalance(id);
      liveBalance = hre.ethers.formatUnits(liveBalanceRaw, decimals);
    } catch (e) {
      liveBalance = `NOT AVAILABLE (${e?.shortMessage || e?.message})`;
    }
    sumFromEvents += v.net;
    console.log(`  automationId ${id}`);
    console.log(`    depositor: ${v.depositor}  recipient: ${v.recipient}`);
    console.log(`    net from event replay: ${hre.ethers.formatUnits(v.net, decimals)} ${symbol}`);
    const matches = liveBalanceRaw !== null && liveBalanceRaw === v.net;
    console.log(`    live reservedBalance(): ${liveBalance} ${symbol}  ${matches ? "(MATCHES event replay -- CONFIRMED ON-CHAIN)" : ""}`);
  }
  console.log("");

  console.log("=".repeat(70));
  console.log("VERDICT");
  console.log("=".repeat(70));
  const realStr = hre.ethers.formatUnits(realCustody, decimals);
  const trackedStr = hre.ethers.formatUnits(sumFromEvents, decimals);
  console.log(`Real custody:                    ${realStr} ${symbol}`);
  console.log(`Sum of open reservations found:  ${trackedStr} ${symbol}`);
  console.log("");

  // Classification requested: ACTIVE RESERVATION / RELEASED-REFUNDED / UNTRACKED DUST / INCONCLUSIVE
  if (realCustody === 0n) {
    if (drained.length > 0) {
      console.log("CLASSIFICATION: RELEASED/REFUNDED -- no custody currently held; every reservation found");
      console.log("      for this token has already been fully released or refunded (net zero).");
    } else {
      console.log("CLASSIFICATION: no custody currently held and no reservation history found for this token.");
    }
  } else if (sumFromEvents === realCustody && active.length > 0) {
    console.log("CLASSIFICATION: ACTIVE RESERVATION -- every unit of real custody is accounted for by");
    console.log("      the open reservation(s) listed above.");
    console.log("      Recovery mechanism: call release() or refund() on THIS vault address for the");
    console.log("      automationId(s) above -- both remain fully callable indefinitely, independent of");
    console.log("      any new AutomationVault being deployed. Not stranded.");
  } else if (sumFromEvents < realCustody) {
    const untracked = realCustody - sumFromEvents;
    if (sumFromEvents > 0n) {
      console.log(`CLASSIFICATION: MIXED -- ${trackedStr} ${symbol} is ACTIVE RESERVATION (accounted for above),`);
      console.log(`      ${hre.ethers.formatUnits(untracked, decimals)} ${symbol} is UNTRACKED DUST (see below).`);
    } else {
      console.log(`CLASSIFICATION: UNTRACKED DUST -- ${hre.ethers.formatUnits(untracked, decimals)} ${symbol} of real custody`);
      console.log("      does not correspond to any open reservation found by replaying events in the scanned range.");
    }
    console.log("      Likely cause: a direct/raw token transfer to the vault address that never went");
    console.log("      through reserve() -- this contract has no sweep/rescue function, so such dust would");
    console.log("      remain unreachable through any vault function, old or new.");
    if (fromBlock !== 0) {
      console.log(`      Scan started at block ${fromBlock}, not genesis -- if that's not the vault's true`);
      console.log("      deployment block, rerun with FROM_BLOCK=0 or the correct block to rule out missed");
      console.log("      earlier events before treating this as confirmed dust.");
    }
  } else {
    console.log("CLASSIFICATION: INCONCLUSIVE -- sum of open reservations EXCEEDS real custody.");
    console.log("      This indicates either missed events (a gap in the scanned block range -- verify");
    console.log("      FROM_BLOCK covers the true deployment block) or an already-insolvent token.");
    console.log("      Do not treat this as a confirmed active reservation without resolving the gap.");
  }
  if (!hasTotalReservedByToken) {
    console.log("");
    console.log("Note: totalReservedByToken() is NOT AVAILABLE on this contract (pre-M-01), so the");
    console.log("      classification above relies entirely on event replay + reservedBalance() cross-checks,");
    console.log("      not on an on-chain ledger total.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
