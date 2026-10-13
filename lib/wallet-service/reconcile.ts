/**
 * Deposit / withdrawal reconciliation — turns real on-chain transfers into
 * wallet notifications.
 *
 * PayAI has no indexer, so this is a bounded, throttled catch-up scan rather
 * than a live watcher: each wallet carries a block checkpoint, and a scan
 * reports only transfers in the range since that checkpoint. Two sources,
 * because the chain exposes the two asset kinds completely differently:
 *
 *   - **ERC-20** — `Transfer` logs, one `eth_getLogs` per direction,
 *     unfiltered by contract so a deposit of ANY token is seen.
 *   - **Native MON** — a native transfer emits no log, so it is invisible to
 *     `eth_getLogs`. Instead the blocks in the window are read with their
 *     transactions and filtered on `to`/`from`. That yields the real txHash,
 *     sender, and `value`, so a native deposit is reported with the same
 *     fidelity as an ERC-20 one. (Diffing `eth_getBalance` would be the
 *     cheap alternative and is deliberately NOT used: it can attribute no
 *     txHash and would read a gas refund as income.)
 *
 * Every notification corresponds to real, verified on-chain movement. Most
 * carry the transaction that caused them; the one exception is an internal
 * native transfer on an RPC without tracing, where the amount is exact but no
 * transaction can be attributed — reported as such rather than guessed at.
 *
 * Two ways to cover a window, chosen by its size:
 *
 *   - **Short windows** (the dashboard open, polling every 20 s) are read
 *     exactly: every Transfer log in and out — any token — and every block
 *     body. Monad's public RPC refuses eth_getLogs over 100 blocks, so logs
 *     are read in 100-block pieces.
 *   - **Long windows** (the wallet was away) can't be read block by block, so
 *     the wallet's balance of MON and of each tracked token is compared
 *     across the gap and bisected only where it changed, down to the exact
 *     block (MON) or 100-block piece (tokens), which is then read for the
 *     transaction. A deposit made while nobody was looking is found when they
 *     come back, instead of the window being skipped. Progress is saved as it
 *     goes, so a long catch-up carries on over the next polls.
 *
 * Known gaps, reported rather than papered over (same convention as
 * lib/monad/wallet-intel.ts):
 *   - **In a long window only MON and the tracked tokens are followed**
 *     (tokenRegistry's curated list). Any other token is caught when it
 *     arrives while the dashboard is open. And a deposit fully cancelled out
 *     by an equal send inside the same unchanged-looking stretch nets to no
 *     balance change and is not seen.
 *   - **Native sends from inside a contract** ARE detected — by tracing where
 *     the RPC supports it, otherwise by exact balance reconciliation, which
 *     yields the right amount but a block range instead of a txHash. What
 *     remains undetectable is an internal transfer in a window too wide to
 *     scan (below), since the reconciliation needs the top-level movements
 *     from that same window to subtract.
 *   - **No historical state** for the start of a long window (an RPC that
 *     prunes it) means that window can't be checked; nothing is invented and
 *     it is surfaced as `nativeComplete: false`.
 *   - **The first scan only establishes a baseline.** It records no events,
 *     otherwise a wallet with years of history would fire hundreds of
 *     "deposit received" notifications the first time its owner signed in.
 *
 * Server-only.
 */
import "server-only";
import { parseAbiItem, formatUnits } from "viem";
import { getPublicClient } from "@/lib/monad/wallet";
import { explorerTx, getChain } from "@/lib/monad/config";
import { resolveToken, trackedTokenAddresses } from "@/lib/monad/tokenRegistry";
import { getRedis } from "@/lib/platform/kv";
import { listWalletEvents, recordWalletEvent } from "@/lib/platform/walletEvents";
import { listTx } from "@/lib/platform/store";
import type { WalletProviderId } from "./types";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Don't re-scan more often than this, however often the client polls. Just
 *  under the dashboard's 20 s refresh, so each refresh while the page is open
 *  looks for new deposits and one is announced within a refresh; extra polls
 *  (several tabs, a manual refresh) inside the window don't scan again. Each
 *  scan only reads the blocks since the last one. */
const SCAN_THROTTLE_MS = 15_000;
/** Hard cap on how far back a scan reaches: ~3.5 days of Monad's ~0.3 s
 *  blocks, within the historical state the public RPC serves. A wallet
 *  dormant for longer starts from there. */
const MAX_SCAN_BLOCKS = 1_000_000n;
/** Monad's public RPC refuses eth_getLogs over more than 100 blocks. */
const LOG_RANGE = 100n;
/** Windows up to this size are read exactly (logs in 100-block pieces, and
 *  every block body); wider ones are caught up by balance. Covers the first
 *  scan's lookback and a dashboard that was hidden for a minute or two. */
const EXACT_WINDOW_BLOCKS = 400n;
/** A long window is first split into this many stretches, each compared on
 *  its own, so a deposit and a send in different stretches can't cancel. */
const CATCHUP_SEGMENTS = 4n;
/** Time a catch-up may spend before saving progress and leaving the rest to
 *  the next poll. Under SCAN_TIMEOUT_MS so progress is always written. */
const CATCHUP_BUDGET_MS = 4_500;
/** How far the very first scan for a wallet looks back, instead of treating
 *  everything before "now" as pre-existing history. Without this, a deposit
 *  that lands moments before (or during) someone's first-ever dashboard
 *  visit falls inside the untouched pre-baseline range and is silently
 *  swallowed — the exact "I deposited and got no notification" report this
 *  fixes. ~2 minutes of Monad's sub-second blocks: enough to catch a deposit
 *  from right before first sign-in, nowhere near enough to replay a dormant
 *  wallet's real history and flood a new user with old activity. */
const BASELINE_LOOKBACK_BLOCKS = 300n;
/** Native detection in an exact window costs one block read per block.
 *  Exact windows are capped well below this; kept as a guard. */
const MAX_NATIVE_SCAN_BLOCKS = 1_500n;
/** Parallel block reads. High enough that a 150-block window is ~12 rounds,
 *  low enough not to look like an attack to the RPC. */
const NATIVE_SCAN_CONCURRENCY = 12;
/** Tracing is far dearer per block than reading one, so it gets its own,
 *  much tighter window — comfortably more than a normal 60s catch-up, and
 *  small enough to finish inside the scan budget. A wider window skips
 *  tracing and reconciles by balance instead. */
const MAX_TRACE_BLOCKS = 300n;
/** Kept below the plain block-read concurrency: these are heavy calls and a
 *  burst of them is the fastest way to get rate-limited off an RPC. */
const TRACE_CONCURRENCY = 6;
/** This runs inline on the notification poll, so a slow or unreachable RPC
 *  must never hold the feed open. Past this, the scan is abandoned and
 *  reported as "not scanned" — the checkpoint is left where it was, so the
 *  same range is simply retried on a later poll. */
const SCAN_TIMEOUT_MS = 8_000;

interface Checkpoint {
  /** Empty means no baseline has been established yet (e.g. the first scan
   *  timed out before it could read a block number). */
  lastBlock: string;
  lastScanAt: number;
}

/** Resolves to `fallback` if `p` hasn't settled in `ms`. The underlying work
 *  is abandoned, not cancelled — it can still finish and write its
 *  checkpoint harmlessly, which is why every write here is idempotent. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const g = globalThis as unknown as { __payaiWalletScan?: Map<string, Checkpoint> };
const mem = (g.__payaiWalletScan ??= new Map());

const key = (merchantId: string, address: string) =>
  `payai:${merchantId}:wallet-scan:${address.toLowerCase()}`;

async function readCheckpoint(merchantId: string, address: string): Promise<Checkpoint | null> {
  const r = await getRedis();
  const raw = r ? await r.get(key(merchantId, address)) : mem.get(key(merchantId, address));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as Checkpoint) : (raw as Checkpoint);
  } catch {
    return null;
  }
}

async function writeCheckpoint(merchantId: string, address: string, cp: Checkpoint): Promise<void> {
  const r = await getRedis();
  if (r) await r.set(key(merchantId, address), JSON.stringify(cp));
  else mem.set(key(merchantId, address), cp);
}

interface TransferLog {
  transactionHash: `0x${string}` | null;
  blockNumber: bigint | null;
  address: `0x${string}`;
  args: { from?: `0x${string}`; to?: `0x${string}`; value?: bigint };
}

/** One asset movement involving this wallet, from either source. */
interface Detected {
  txHash: string;
  direction: "in" | "out";
  /** ERC-20 contract address, or null for the chain's native asset. */
  token: `0x${string}` | null;
  value: bigint;
  /** Native value that arrived from inside a contract rather than as a
   *  top-level transfer. When detected by balance reconciliation there is no
   *  transaction to point at, so `txHash` is a synthetic block-range marker. */
  internal?: boolean;
}

/** One direction of ERC-20 Transfer logs for this address. Deliberately not
 *  filtered to a contract allowlist, so a deposit of ANY token is seen. */
async function pullTransfers(
  role: "from" | "to",
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TransferLog[]> {
  // In pieces the RPC accepts. One request for the whole window used to be
  // refused outright past 100 blocks, silently dropping every token deposit
  // in it.
  const pieces: [bigint, bigint][] = [];
  for (let b = fromBlock; b <= toBlock; b += LOG_RANGE) {
    pieces.push([b, b + LOG_RANGE - 1n < toBlock ? b + LOG_RANGE - 1n : toBlock]);
  }
  const results = await Promise.all(
    pieces.map(([from, to]) =>
      (getPublicClient().getLogs({
        event: TRANSFER_EVENT,
        args: { [role]: address } as never,
        fromBlock: from,
        toBlock: to,
      }) as unknown as Promise<TransferLog[]>).catch(
        // RPC refused this piece — report nothing for it rather than guess.
        () => [] as TransferLog[],
      ),
    ),
  );
  return results.flat();
}

/* ── Internal (contract-originated) native transfers ──────────────────────
 *
 * MON paid out from inside a contract — a DEX settling a swap, unwrapping
 * WMON, a refund — moves value without a top-level transaction, so block
 * bodies cannot see it. Two ways to catch it, tried in order:
 *
 *   1. `debug_traceBlockByNumber` with callTracer, when the RPC exposes it.
 *      Gives the real txHash and exact amount. Capability is probed once and
 *      remembered, so an RPC without it costs one failed call per process.
 *
 *   2. Otherwise, exact balance reconciliation. The native balance at each end
 *      of the window is compared, and everything already accounted for —
 *      top-level value in, value out, and gas this wallet actually paid — is
 *      subtracted. Whatever remains arrived from inside a contract. This is
 *      arithmetic on real on-chain values, not an estimate: the balance moved,
 *      and every other explanation for the movement has been subtracted. What
 *      it cannot give is a txHash, so such a deposit is reported against the
 *      block range instead of a transaction, and says so.
 */

/** Remembered per process: undefined = not probed, false = RPC lacks tracing. */
let traceSupported: boolean | undefined;

interface TraceCall {
  from?: string;
  to?: string;
  value?: string;
  calls?: TraceCall[];
}

/** Walks a callTracer tree for value-bearing calls into `address`, skipping
 *  the outermost call (that is the top-level transfer, already counted). */
function collectInternal(node: TraceCall, address: string, out: bigint[], depth = 0): void {
  if (depth > 0 && node.to?.toLowerCase() === address && node.value) {
    try {
      const v = BigInt(node.value);
      if (v > 0n) out.push(v);
    } catch {
      /* malformed value — ignore rather than guess */
    }
  }
  for (const child of node.calls ?? []) collectInternal(child, address, out, depth + 1);
}

async function traceInternalTransfers(
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Detected[] | null> {
  if (traceSupported === false) return null;
  // Tracing a block is by far the most expensive read in this file. Issued one
  // block at a time across a window that can legitimately be 1,500 blocks
  // wide, it could never finish inside the scan's 8s budget on an RPC that
  // actually supports the method — so this path only appeared to work because
  // most RPCs reject it on the first call. Cap the window and read it in
  // parallel; anything wider falls through to balance reconciliation, which is
  // range-independent.
  if (toBlock - fromBlock + 1n > MAX_TRACE_BLOCKS) return null;

  const pub = getPublicClient();
  const numbers: bigint[] = [];
  for (let b = fromBlock; b <= toBlock; b++) numbers.push(b);

  const traceBlock = async (b: bigint) =>
    (await (pub as unknown as {
      request: (a: { method: string; params: unknown[] }) => Promise<unknown>;
    }).request({
      method: "debug_traceBlockByNumber",
      params: [`0x${b.toString(16)}`, { tracer: "callTracer" }],
    })) as { txHash?: string; result?: TraceCall }[];

  const harvest = (traces: { txHash?: string; result?: TraceCall }[], into: Detected[]) => {
    for (const entry of traces) {
      if (!entry?.result || !entry.txHash) continue;
      const amounts: bigint[] = [];
      collectInternal(entry.result, address, amounts);
      for (const value of amounts) {
        into.push({ txHash: entry.txHash.toLowerCase(), direction: "in", token: null, value, internal: true });
      }
    }
  };

  const found: Detected[] = [];

  // Probe once, serially: an RPC without the method must cost one failed call,
  // not a burst of them.
  if (traceSupported === undefined) {
    try {
      const probe = await traceBlock(numbers[0]);
      if (!Array.isArray(probe)) { traceSupported = false; return null; }
      traceSupported = true;
      harvest(probe, found);
    } catch {
      traceSupported = false;
      return null;
    }
    numbers.shift();
  }

  for (let i = 0; i < numbers.length; i += TRACE_CONCURRENCY) {
    const batch = await Promise.all(
      numbers.slice(i, i + TRACE_CONCURRENCY).map((b) => traceBlock(b).catch(() => null)),
    );
    for (const traces of batch) {
      // One refused block is a gap in the window, not a reason to throw the
      // whole scan away. A shape we don't recognise is different: it means the
      // method isn't what we think it is, so stop trusting it entirely.
      if (traces === null) continue;
      if (!Array.isArray(traces)) { traceSupported = false; return null; }
      harvest(traces, found);
    }
  }
  return found;
}

/**
 * Exact residual native inflow across the window: whatever the balance gained
 * that top-level transfers and gas cannot explain.
 */
async function reconcileNativeByBalance(
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  topLevel: Detected[],
): Promise<bigint> {
  const pub = getPublicClient();
  let before: bigint;
  let after: bigint;
  try {
    [before, after] = await Promise.all([
      pub.getBalance({ address, blockNumber: fromBlock - 1n }),
      pub.getBalance({ address, blockNumber: toBlock }),
    ]);
  } catch {
    return 0n; // archive state unavailable — report nothing rather than guess
  }

  let accounted = 0n;
  const ourTxs: string[] = [];
  for (const t of topLevel) {
    if (t.token !== null) continue; // ERC-20 moves don't touch the native balance
    if (t.direction === "in") accounted += t.value;
    else { accounted -= t.value; ourTxs.push(t.txHash); }
  }

  // Gas this wallet actually burned on its own transactions in the window.
  for (const hash of ourTxs) {
    try {
      const r = await pub.getTransactionReceipt({ hash: hash as `0x${string}` });
      const used = r.gasUsed ?? 0n;
      const price = (r as unknown as { effectiveGasPrice?: bigint }).effectiveGasPrice ?? 0n;
      accounted -= used * price;
    } catch {
      // Without the receipt the gas is unknown; treating it as zero would
      // inflate the residual and invent a deposit, so abandon instead.
      return 0n;
    }
  }

  const residual = after - before - accounted;
  return residual > 0n ? residual : 0n;
}

/**
 * Native MON transfers in the window, read straight from block bodies.
 * `complete: false` means the window was too wide to scan and native
 * transfers in it were not looked for — never that there were none.
 */
async function pullNativeTransfers(
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ transfers: Detected[]; complete: boolean }> {
  if (toBlock - fromBlock + 1n > MAX_NATIVE_SCAN_BLOCKS) return { transfers: [], complete: false };

  const numbers: bigint[] = [];
  for (let b = fromBlock; b <= toBlock; b++) numbers.push(b);

  const pub = getPublicClient();
  const transfers: Detected[] = [];

  for (let i = 0; i < numbers.length; i += NATIVE_SCAN_CONCURRENCY) {
    const blocks = await Promise.all(
      numbers.slice(i, i + NATIVE_SCAN_CONCURRENCY).map((blockNumber) =>
        pub.getBlock({ blockNumber, includeTransactions: true }).catch(() => null),
      ),
    );
    for (const block of blocks) {
      if (!block) continue;
      for (const tx of block.transactions) {
        // A client configured without full transactions returns hashes; there
        // is nothing to inspect in that case.
        if (typeof tx === "string") continue;
        const value = tx.value ?? 0n;
        if (value === 0n) continue; // a plain contract call, not a transfer
        const from = tx.from?.toLowerCase();
        const to = tx.to?.toLowerCase();
        if (from !== address && to !== address) continue;
        // Moving MON to yourself is neither a deposit nor a withdrawal.
        // Filtered here rather than downstream because, unlike the ERC-20
        // path, a native self-transfer appears only once and so would
        // otherwise read as a plain incoming deposit.
        if (from === to) continue;
        transfers.push({
          txHash: tx.hash.toLowerCase(),
          direction: to === address ? "in" : "out",
          token: null,
          value,
        });
      }
    }
  }
  return { transfers, complete: true };
}

/* ── Catching up a long window by balance ─────────────────────────────── */

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** null is the chain's native asset. */
type Asset = `0x${string}` | null;

async function balanceAt(asset: Asset, address: `0x${string}`, blockNumber: bigint): Promise<bigint> {
  const pub = getPublicClient();
  if (asset === null) return pub.getBalance({ address, blockNumber });
  return (await pub.readContract({
    address: asset, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address], blockNumber,
  })) as bigint;
}

class OutOfBudget extends Error {}

interface CatchUp {
  detected: Detected[];
  /** Transactions that moved a token from the wallet to itself. */
  self: string[];
  /** Every block up to here has been checked; the checkpoint may move here. */
  resolvedTo: bigint;
  complete: boolean;
}

/** What one block did to the wallet's native balance. Top-level transfers
 *  come with their transaction; whatever is left after them and the gas the
 *  wallet paid arrived from inside a contract. */
async function nativeBlock(
  address: `0x${string}`,
  block: bigint,
  before: bigint,
  after: bigint,
  out: Detected[],
): Promise<void> {
  const pub = getPublicClient();
  const body = await pub.getBlock({ blockNumber: block, includeTransactions: true });
  let accounted = 0n;
  const ours: string[] = [];
  for (const tx of body.transactions) {
    if (typeof tx === "string") continue;
    const from = tx.from?.toLowerCase();
    const to = tx.to?.toLowerCase();
    if (from !== address && to !== address) continue;
    const value = tx.value ?? 0n;
    if (from === address) ours.push(tx.hash);
    if (from === to || value === 0n) continue;
    if (to === address) {
      out.push({ txHash: tx.hash.toLowerCase(), direction: "in", token: null, value });
      accounted += value;
    } else {
      out.push({ txHash: tx.hash.toLowerCase(), direction: "out", token: null, value });
      accounted -= value;
    }
  }
  for (const hash of ours) {
    try {
      const r = await pub.getTransactionReceipt({ hash: hash as `0x${string}` });
      const price = (r as unknown as { effectiveGasPrice?: bigint }).effectiveGasPrice ?? 0n;
      accounted -= (r.gasUsed ?? 0n) * price;
    } catch {
      return; // gas unknown: an internal deposit can't be told apart, so none is claimed
    }
  }
  const residual = after - before - accounted;
  if (residual <= 0n) return;
  const traced = await traceInternalTransfers(address, block, block);
  if (traced && traced.length > 0) {
    out.push(...traced);
    return;
  }
  out.push({ txHash: `internal:${block}-${block}`, direction: "in", token: null, value: residual, internal: true });
}

/**
 * Follows one asset's balance across [from, to]: compared at a few points,
 * then bisected only where it changed. Native changes are narrowed to the
 * exact block; token changes to a 100-block piece read by log.
 */
async function catchUpAsset(
  asset: Asset,
  address: `0x${string}`,
  from: bigint,
  to: bigint,
  deadline: number,
): Promise<CatchUp> {
  const result: CatchUp = { detected: [], self: [], resolvedTo: from - 1n, complete: false };
  const start = from - 1n;
  const span = to - start;
  const n = span < CATCHUP_SEGMENTS ? span : CATCHUP_SEGMENTS;
  const points: bigint[] = [];
  for (let i = 0n; i <= n; i++) points.push(start + (span * i) / n);

  let bals: bigint[];
  try {
    bals = await Promise.all(points.map((b) => balanceAt(asset, address, b)));
  } catch {
    // No historical state for this window. Nothing can be said about it, so
    // nothing is invented; the window is passed rather than retried forever.
    return { ...result, resolvedTo: to };
  }

  const tokenPiece = async (lo: bigint, hi: bigint) => {
    const pub = getPublicClient();
    const read = (role: "from" | "to") =>
      pub.getLogs({
        address: asset as `0x${string}`,
        event: TRANSFER_EVENT,
        args: { [role]: address } as never,
        fromBlock: lo,
        toBlock: hi,
      }) as unknown as Promise<TransferLog[]>;
    const [inLogs, outLogs] = await Promise.all([read("to"), read("from")]);
    for (const [logs, direction] of [[inLogs, "in"], [outLogs, "out"]] as const) {
      for (const l of logs) {
        const txHash = (l.transactionHash ?? "").toLowerCase();
        if (l.args?.from?.toLowerCase() === l.args?.to?.toLowerCase()) { result.self.push(txHash); continue; }
        result.detected.push({ txHash, direction, token: l.address, value: l.args?.value ?? 0n });
      }
    }
  };

  // Depth-first, left to right, so everything before the current position is
  // settled and progress can be saved exactly there.
  const descend = async (lo: bigint, hi: bigint, bLo: bigint, bHi: bigint): Promise<void> => {
    if (bLo !== bHi) {
      if (Date.now() > deadline) throw new OutOfBudget();
      if (asset !== null && hi - lo <= LOG_RANGE) {
        await tokenPiece(lo + 1n, hi);
      } else if (asset === null && hi - lo === 1n) {
        await nativeBlock(address, hi, bLo, bHi, result.detected);
      } else {
        const mid = lo + (hi - lo) / 2n;
        const bMid = await balanceAt(asset, address, mid);
        await descend(lo, mid, bLo, bMid);
        await descend(mid, hi, bMid, bHi);
        return;
      }
    }
    result.resolvedTo = hi;
  };

  try {
    for (let i = 0; i < points.length - 1; i++) await descend(points[i], points[i + 1], bals[i], bals[i + 1]);
    result.complete = true;
  } catch {
    // Out of time, or a read failed: keep what was found, save progress up to
    // the last settled block, and pick up from there on the next poll.
  }
  return result;
}

async function catchUp(address: `0x${string}`, from: bigint, to: bigint, deadline: number) {
  let tokens: `0x${string}`[] = [];
  try {
    tokens = trackedTokenAddresses();
  } catch {
    /* no token list — MON is still followed */
  }
  const assets: Asset[] = [null, ...tokens];
  const runs = await Promise.all(assets.map((a) => catchUpAsset(a, address, from, to, deadline)));
  return {
    detected: runs.flatMap((r) => r.detected),
    self: new Set(runs.flatMap((r) => r.self)),
    resolvedTo: runs.reduce((m, r) => (r.resolvedTo < m ? r.resolvedTo : m), to),
    nativeComplete: runs[0].complete,
  };
}

/** A short window, read exactly: every Transfer log in and out (any
 *  token) and every block body, plus contract-originated MON. */
async function exactWindow(address: `0x${string}`, fromBlock: bigint, latest: bigint) {
  const [incoming, outgoing, native] = await Promise.all([
    pullTransfers("to", address, fromBlock, latest),
    pullTransfers("from", address, fromBlock, latest),
    pullNativeTransfers(address, fromBlock, latest),
  ]);

  // MON paid out from inside a contract is invisible to all three of the
  // above. Prefer tracing (gives a real txHash); fall back to reconciling the
  // balance, which gives an exact amount but only a block range.
  let internal: Detected[] = [];
  if (native.complete) {
    const traced = await traceInternalTransfers(address, fromBlock, latest);
    if (traced) {
      internal = traced;
    } else {
      const residual = await reconcileNativeByBalance(address, fromBlock, latest, native.transfers);
      if (residual > 0n) {
        internal = [{
          // Not a transaction hash — a marker for the window the funds arrived
          // in, so the event de-dupes correctly and never links to a tx that
          // doesn't exist.
          txHash: `internal:${fromBlock}-${latest}`,
          direction: "in",
          token: null,
          value: residual,
          internal: true,
        }];
      }
    }
  }

  const detected: Detected[] = [
    ...incoming.map((l): Detected => ({
      txHash: (l.transactionHash ?? "").toLowerCase(),
      direction: "in",
      token: l.address,
      value: l.args?.value ?? 0n,
    })),
    ...outgoing.map((l): Detected => ({
      txHash: (l.transactionHash ?? "").toLowerCase(),
      direction: "out",
      token: l.address,
      value: l.args?.value ?? 0n,
    })),
    ...native.transfers,
    ...internal,
    // A self-transfer shows up in both log directions; drop it before it can
    // be counted as either a deposit or a withdrawal.
  ].filter((d) => d.txHash && d.value > 0n);

  const selfTransfers = new Set(
    incoming
      .filter((l) => l.args?.from?.toLowerCase() === l.args?.to?.toLowerCase())
      .map((l) => (l.transactionHash ?? "").toLowerCase()),
  );

  return { detected, self: selfTransfers, nativeComplete: native.complete };
}

export interface ReconcileResult {
  scanned: boolean;
  deposits: number;
  withdrawals: number;
  /** True on the very first scan for a wallet, which only sets the baseline. */
  baseline?: boolean;
  /** False when the window was too wide for native detection — native
   *  transfers in it were not looked for. Absent when nothing was scanned. */
  nativeComplete?: boolean;
}

/**
 * Catch up this wallet's transfer history and raise a notification for each
 * new one. Safe to call on every notification poll — it self-throttles, and
 * de-dupes by txHash so a concurrent double-call can't double-notify.
 */
export async function reconcileWalletTransfers(input: {
  merchantId: string;
  address: string;
  providerId: WalletProviderId;
}): Promise<ReconcileResult> {
  const address = input.address.toLowerCase() as `0x${string}`;
  const now = Date.now();

  const cp = await readCheckpoint(input.merchantId, address);
  if (cp && now - cp.lastScanAt < SCAN_THROTTLE_MS) {
    return { scanned: false, deposits: 0, withdrawals: 0 };
  }

  // Stamp the attempt BEFORE doing any network work. If the scan then stalls
  // and gets abandoned, this is what stops the next poll 20s later from
  // starting another doomed 8-second scan. lastBlock is left untouched, so
  // no range is ever skipped as a result.
  await writeCheckpoint(input.merchantId, address, { lastBlock: cp?.lastBlock ?? "", lastScanAt: now });

  // The scan is abandoned on timeout, not cancelled — so it can still reject
  // long after nobody is awaiting it. An unawaited rejection is an unhandled
  // promise rejection in the server process, which is a far worse outcome
  // than the missed scan it would be reporting. Swallow it at the source.
  const running = scan(input, address, cp, now).catch(
    (): ReconcileResult => ({ scanned: false, deposits: 0, withdrawals: 0 }),
  );
  return withTimeout(running, SCAN_TIMEOUT_MS, {
    scanned: false,
    deposits: 0,
    withdrawals: 0,
  });
}

async function scan(
  input: { merchantId: string; address: string; providerId: WalletProviderId },
  address: `0x${string}`,
  cp: Checkpoint | null,
  now: number,
): Promise<ReconcileResult> {
  const scanStartedAt = Date.now();
  let latest: bigint;
  try {
    latest = await getPublicClient().getBlockNumber();
  } catch {
    return { scanned: false, deposits: 0, withdrawals: 0 };
  }

  // First sight of this wallet (or a previous first attempt that never got a
  // block number): rather than a blank baseline that ignores everything up
  // to this instant, start the window a short lookback behind "now" so a
  // deposit from just before this first scan still gets caught below.
  const baseline = !cp?.lastBlock;
  const since = baseline
    ? (latest > BASELINE_LOOKBACK_BLOCKS ? latest - BASELINE_LOOKBACK_BLOCKS : 0n)
    : BigInt(cp!.lastBlock);

  if (!baseline && latest <= since) {
    await writeCheckpoint(input.merchantId, address, { lastBlock: latest.toString(), lastScanAt: now });
    return { scanned: true, deposits: 0, withdrawals: 0, nativeComplete: true };
  }
  const fromBlock = latest - since > MAX_SCAN_BLOCKS ? latest - MAX_SCAN_BLOCKS : since + 1n;

  // A long gap is caught up by balance, the rest of the way on later polls
  // if it doesn't fit in one; a short one is read exactly.
  const long = latest - fromBlock + 1n > EXACT_WINDOW_BLOCKS;
  const found = long
    ? await catchUp(address, fromBlock, latest, scanStartedAt + CATCHUP_BUDGET_MS)
    : { ...(await exactWindow(address, fromBlock, latest)), resolvedTo: latest };
  const detected = found.detected.filter((d) => d.txHash && d.value > 0n);
  const selfTransfers = found.self;

  // Everything PayAI itself settled is already in the tx log and has already
  // produced a "Payment sent" notification — re-reporting those as
  // withdrawals would notify twice for one transfer.
  const ownTxHashes = new Set(
    (await listTx(input.merchantId, { sender: address }).catch(() => []))
      .map((t) => t.txHash?.toLowerCase())
      .filter(Boolean) as string[],
  );
  // Guards against a concurrent scan having already recorded these.
  const alreadyRecorded = new Set(
    (await listWalletEvents(input.merchantId, address).catch(() => []))
      .map((e) => e.txHash?.toLowerCase())
      .filter(Boolean) as string[],
  );

  const nativeCurrency = getChain().nativeCurrency;
  let deposits = 0;
  let withdrawals = 0;

  for (const d of detected) {
    // Dedupe on txHash alone: one transaction produces at most one
    // notification, even in the rare case where it moves two assets. Missing
    // the second line of a combined transfer is a far better failure than
    // notifying twice for the same transaction.
    if (alreadyRecorded.has(d.txHash) || selfTransfers.has(d.txHash)) continue;
    if (d.direction === "out" && ownTxHashes.has(d.txHash)) continue;

    let symbol = d.token === null ? nativeCurrency.symbol : "tokens";
    let amount: number | null = null;
    if (d.token === null) {
      amount = Number(formatUnits(d.value, nativeCurrency.decimals));
    } else {
      try {
        const token = await resolveToken(d.token);
        symbol = token.symbol;
        amount = Number(formatUnits(d.value, token.decimals));
      } catch {
        // Unresolvable token metadata — still a real transfer worth
        // reporting, just without a formatted amount. Never invent one.
      }
    }

    const pretty = amount != null ? `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}` : symbol;
    alreadyRecorded.add(d.txHash);
    await recordWalletEvent({
      merchantId: input.merchantId,
      sender: address,
      providerId: input.providerId,
      type: d.direction === "in" ? "deposit_received" : "withdrawal_completed",
      title: d.direction === "in" ? "Deposit received" : "Withdrawal completed",
      detail:
        d.direction === "in"
          ? d.internal
            ? `${pretty} arrived in your wallet from a contract.`
            : `${pretty} arrived in your wallet.`
          : `${pretty} left your wallet in a transaction not made through PayAI.`,
      amount,
      token: symbol,
      txHash: d.txHash,
      explorerUrl: d.txHash.startsWith("internal:") ? undefined : explorerTx(d.txHash),
    }).catch(() => {});
    if (d.direction === "in") deposits++;
    else withdrawals++;
  }

  // Only as far as was actually checked: a catch-up that ran out of time
  // carries on from here next poll instead of skipping the rest.
  await writeCheckpoint(input.merchantId, address, { lastBlock: found.resolvedTo.toString(), lastScanAt: now });
  return { scanned: true, deposits, withdrawals, nativeComplete: found.nativeComplete, ...(baseline ? { baseline: true } : {}) };
}
