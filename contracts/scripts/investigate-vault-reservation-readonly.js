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
 * per request ("eth_getLogs is limited to a 100 range") AND rate-limits to
 * 50 requests/second ("50/second request limit reached"). Every getLogs
 * call below is capped at 100 blocks; Reserved/Released/Refunded are fetched
 * in a SINGLE combined call per window (topic0 OR-list); ALL requests (log
 * scans, block lookups) go through a shared rate limiter capped well under
 * 50/sec (RPC_MAX_REQUESTS_PER_SECOND, default 20) regardless of how many
 * are in flight concurrently -- concurrency alone does not bound requests/sec
 * if individual calls are fast, so this is an explicit sliding-window
 * throttle, not just a worker-pool size.
 *
 * DEPLOYMENT BLOCK -- DO NOT SCAN FROM GENESIS: the repository has no block
 * number or transaction hash for AutomationVault 0x1b84c9Aa7E46b90d6e49422e1
 * Cf18142AAD3FE0f anywhere (checked: deployed-suite-v3-fresh.json, the
 * deploy script, and a repo-wide grep for the address near any block/tx
 * field -- none exists; deploy scripts only ever log human-readable console
 * output, never a block number, to any committed file). The only deploy-time
 * evidence in the repo is the ISO timestamp
 * `"deployedAt": "2026-07-08T23:16:18.344Z"` in that JSON file, written by
 * deploy-suite-v3-fresh.js via `new Date().toISOString()` immediately after
 * `vault.waitForDeployment()` resolved -- i.e. AFTER the tx was already
 * mined, with unknown small latency from RPC round-trip.
 *
 * If FROM_BLOCK isn't set explicitly, this script converts that timestamp to
 * a block number via BINARY SEARCH OVER BLOCK HEADERS (eth_getBlockByNumber,
 * comparing `.timestamp`) -- NOT eth_getCode. Headers are retained by every
 * node (full or pruned), unlike historical state, so this doesn't require
 * archive access and works on a non-archive RPC. ~30 rate-limited calls
 * total (log2 of the full block range), then backs off an extra
 * DEPLOY_BLOCK_SAFETY_MARGIN blocks (default 2,000 -- several minutes' worth
 * even on a sub-second-block chain) to guard against the recorded timestamp
 * being a few seconds after the true mining time, so the scan can only start
 * AT OR BEFORE the real deployment block, never after it.
 *
 * FASTEST OPTION: if you have access to a Monad block explorer, looking up
 * 0x1b84c9Aa7E46b90d6e49422e1Cf18142AAD3FE0f there gives the exact creation
 * block instantly with zero RPC calls -- pass it via FROM_BLOCK to skip
 * auto-detection entirely.
 *
 * SAFETY: read-only. Only eth_getLogs, eth_getBlockByNumber, and view-
 * function calls via a plain JSON-RPC provider. No signer, no private key,
 * no transaction, ever.
 *
 * Required env:
 *   MONAD_MAINNET_AUTOMATION_VAULT
 * Optional:
 *   MONAD_MAINNET_RPC            -- defaults to https://rpc.monad.xyz
 *   TOKEN_TO_CHECK                -- ERC-20 address to net out; defaults to
 *                                    MONAD_MAINNET_USDC. Use "native" (or
 *                                    leave unset with no USDC env either)
 *                                    to check MON.
 *   FROM_BLOCK                    -- explicit starting block. STRONGLY
 *                                    recommended if you know it (e.g. from a
 *                                    block explorer) -- skips auto-detection
 *                                    entirely. If unset, auto-detected from
 *                                    the deploy timestamp (see above).
 *   DEPLOY_TIMESTAMP_ISO          -- override the timestamp used for
 *                                    auto-detection (default: the vault's
 *                                    recorded 2026-07-08T23:16:18.344Z).
 *   DEPLOY_BLOCK_SAFETY_MARGIN    -- blocks to back off from the detected
 *                                    timestamp match (default 2000).
 *   LOG_CHUNK_BLOCKS               -- block window per getLogs call,
 *                                    hard-capped at 100 (default 100).
 *   LOG_SCAN_CONCURRENCY           -- parallel in-flight requests (default 4).
 *   RPC_MAX_REQUESTS_PER_SECOND    -- shared rate limit across ALL requests
 *                                    (default 20, safely under the RPC's 50).
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
// From contracts/deployed-suite-v3-fresh.json's "deployedAt" field -- the
// only deploy-time evidence for this vault anywhere in the repository.
const KNOWN_VAULT_DEPLOY_TIMESTAMP_ISO = "2026-07-08T23:16:18.344Z";

/** Sliding-window rate limiter shared across every RPC call the script makes. */
class RateLimiter {
  constructor(maxPerSecond) {
    this.maxPerSecond = maxPerSecond;
    this.timestamps = [];
  }
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 1000);
      if (this.timestamps.length < this.maxPerSecond) {
        this.timestamps.push(now);
        return;
      }
      const waitMs = 1000 - (now - this.timestamps[0]) + 5;
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 5)));
    }
  }
}

/**
 * Binary-search block headers (NOT state) for the first block whose
 * timestamp is >= targetTimestampSec, then back off `safetyMargin` blocks.
 * Works on non-archive nodes since headers are never pruned.
 */
async function findDeploymentBlockByTimestamp(provider, limiter, targetTimestampSec, latest, safetyMargin) {
  await limiter.acquire();
  const latestBlock = await provider.getBlock(latest);
  if (!latestBlock) return { error: `could not fetch latest block ${latest}` };
  if (latestBlock.timestamp < targetTimestampSec) {
    return { error: "target deploy timestamp is after the current latest block -- clock mismatch, refusing to guess" };
  }

  let lo = 0;
  let hi = latest;
  let calls = 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    await limiter.acquire();
    calls++;
    const block = await provider.getBlock(mid);
    if (!block) return { error: `getBlock(${mid}) returned null` };
    if (block.timestamp < targetTimestampSec) lo = mid + 1;
    else hi = mid;
  }
  const matched = lo;
  const withMargin = Math.max(matched - safetyMargin, 0);
  return { matchedBlock: matched, blockWithMargin: withMargin, calls };
}

/** Fetch eth_getLogs across [fromBlock, toBlock] in <=100-block windows, rate-limited + bounded concurrency. */
async function scanLogsInChunks(provider, limiter, filter, fromBlock, toBlock, chunkSize, concurrency) {
  const windows = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    windows.push([start, Math.min(start + chunkSize - 1, toBlock)]);
  }
  const totalWindows = windows.length;
  const estSeconds = Math.ceil(totalWindows / limiter.maxPerSecond);
  console.log(`  ${totalWindows} window(s) of <=${chunkSize} blocks each, concurrency ${concurrency}, rate-limited to ${limiter.maxPerSecond}/sec.`);
  console.log(`  Estimated minimum time: ~${estSeconds}s (${(estSeconds / 60).toFixed(1)} min), likely longer with real network latency.`);

  const allLogs = [];
  let nextIndex = 0;
  let completed = 0;
  let lastReported = -1;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= windows.length) return;
      const [start, end] = windows[i];
      await limiter.acquire();
      const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end });
      if (logs.length) allLogs.push(...logs);
      completed++;
      const pct = Math.floor((completed / totalWindows) * 100);
      if (pct >= lastReported + 5 || completed === totalWindows) {
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
  const concurrency = Number(process.env.LOG_SCAN_CONCURRENCY ?? 4);
  const maxReqPerSec = Number(process.env.RPC_MAX_REQUESTS_PER_SECOND ?? 20);
  const safetyMargin = Number(process.env.DEPLOY_BLOCK_SAFETY_MARGIN ?? 2000);
  const limiter = new RateLimiter(maxReqPerSec);

  const provider = new hre.ethers.JsonRpcProvider(rpcUrl, { chainId: 143, name: "monad" });
  const vault = new hre.ethers.Contract(vaultAddr, VAULT_ABI, provider);

  await limiter.acquire();
  const latest = await provider.getBlockNumber();

  let fromBlock;
  let fromBlockEvidence;
  if (process.env.FROM_BLOCK !== undefined) {
    fromBlock = Number(process.env.FROM_BLOCK);
    fromBlockEvidence = "explicitly set via FROM_BLOCK env var";
  } else {
    const targetIso = process.env.DEPLOY_TIMESTAMP_ISO || KNOWN_VAULT_DEPLOY_TIMESTAMP_ISO;
    const targetSec = Math.floor(new Date(targetIso).getTime() / 1000);
    console.log(`FROM_BLOCK not set -- deriving it from the vault's recorded deploy timestamp (${targetIso}, from`);
    console.log("contracts/deployed-suite-v3-fresh.json) via binary search over block HEADERS (eth_getBlockByNumber");
    console.log("timestamps, not eth_getCode/state -- works without archive access).");
    const result = await findDeploymentBlockByTimestamp(provider, limiter, targetSec, latest, safetyMargin);
    if (result.error) {
      throw new Error(
        `Deployment-block auto-detection failed: ${result.error}. Refusing to fall back to genesis. ` +
          "Set FROM_BLOCK explicitly (e.g. from a block explorer lookup of the vault address) and rerun.",
      );
    }
    fromBlock = result.blockWithMargin;
    fromBlockEvidence =
      `binary search matched block ${result.matchedBlock} as the first block with timestamp >= target ` +
      `(${result.calls} rate-limited eth_getBlockByNumber calls), minus a ${safetyMargin}-block safety margin`;
    console.log(`  Matched block: ${result.matchedBlock}. Using FROM_BLOCK=${fromBlock} after safety margin.`);
  }

  console.log("=".repeat(70));
  console.log("READ-ONLY VAULT RESERVATION INVESTIGATION");
  console.log("=".repeat(70));
  console.log(`Vault:          ${vaultAddr}`);
  console.log(`Token checked:  ${isNative ? "native MON" : tokenAddr}`);
  console.log(`FROM_BLOCK:     ${fromBlock}`);
  console.log(`Evidence:       ${fromBlockEvidence}`);
  console.log(`Block range:    ${fromBlock} .. ${latest} (${latest - fromBlock + 1} blocks, ${chunkSize}-block windows)`);
  console.log(`Rate limit:     ${maxReqPerSec} req/sec shared across all calls, concurrency ${concurrency}`);
  console.log("");

  // Ground truth: real custody right now.
  let realCustody;
  let decimals = 18, symbol = isNative ? "MON" : "TOKEN";
  await limiter.acquire();
  if (isNative) {
    realCustody = await provider.getBalance(vaultAddr);
  } else {
    const token = new hre.ethers.Contract(tokenAddr, ERC20_ABI, provider);
    realCustody = await token.balanceOf(vaultAddr);
    try {
      await limiter.acquire();
      decimals = Number(await token.decimals());
    } catch {}
    try {
      await limiter.acquire();
      symbol = await token.symbol();
    } catch {}
  }
  console.log(`Real custody (balanceOf/balance) right now: ${hre.ethers.formatUnits(realCustody, decimals)} ${symbol}`);

  let hasTotalReservedByToken = false;
  try {
    await limiter.acquire();
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
  const allLogs = await scanLogsInChunks(provider, limiter, { address: vaultAddr, topics }, fromBlock, latest, chunkSize, concurrency);

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
      await limiter.acquire();
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
    console.log(`      Scan started at block ${fromBlock} (${fromBlockEvidence}) -- if the true deployment`);
    console.log("      block is earlier than that, rerun with a lower FROM_BLOCK to rule out missed events");
    console.log("      before treating this as confirmed dust.");
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
