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
 * Every notification therefore corresponds to a real transaction. Nothing is
 * inferred from balance changes.
 *
 * Known gaps, reported rather than papered over (same convention as
 * lib/monad/wallet-intel.ts):
 *   - **Native sends from inside a contract** (a DEX paying out MON, say)
 *     move value without a top-level transaction, so they need trace APIs
 *     that public RPCs don't expose. Direct transfers — what "someone sent
 *     me MON" actually is — are caught.
 *   - **A window wider than MAX_NATIVE_SCAN_BLOCKS** skips native detection
 *     for that window (ERC-20 still scans, being range-independent), rather
 *     than issuing tens of thousands of block reads. Surfaced as
 *     `nativeComplete: false`.
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
import { resolveToken } from "@/lib/monad/tokenRegistry";
import { getRedis } from "@/lib/platform/kv";
import { listWalletEvents, recordWalletEvent } from "@/lib/platform/walletEvents";
import { listTx } from "@/lib/platform/store";
import type { WalletProviderId } from "./types";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Don't re-scan more often than this, however often the client polls. The
 *  notification feed refreshes every 20s; a chain scan every 20s per user
 *  would be wasteful and rate-limit the RPC for no benefit. */
const SCAN_THROTTLE_MS = 60_000;
/** Hard cap on how far back a single scan reaches. A wallet dormant for
 *  months skips the gap (and says so via the advanced checkpoint) instead of
 *  issuing an unbounded getLogs the RPC will reject anyway. */
const MAX_SCAN_BLOCKS = 50_000n;
/** Native detection costs one block read per block, so it gets a much
 *  tighter cap than the log scan. Monad's sub-second blocks put a normal
 *  60s catch-up at ~150 blocks, so this leaves ~10x headroom for a user who
 *  was away a little longer, while refusing to melt the RPC for one who was
 *  away for days. */
const MAX_NATIVE_SCAN_BLOCKS = 1_500n;
/** Parallel block reads. High enough that a 150-block window is ~12 rounds,
 *  low enough not to look like an attack to the RPC. */
const NATIVE_SCAN_CONCURRENCY = 12;
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
}

/** One direction of ERC-20 Transfer logs for this address. Deliberately not
 *  filtered to a contract allowlist, so a deposit of ANY token is seen. */
async function pullTransfers(
  role: "from" | "to",
  address: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TransferLog[]> {
  try {
    return (await getPublicClient().getLogs({
      event: TRANSFER_EVENT,
      args: { [role]: address } as never,
      fromBlock,
      toBlock,
    })) as unknown as TransferLog[];
  } catch {
    // RPC refused the range or the unfiltered query — report nothing rather
    // than guessing. The checkpoint still advances, so this is a skipped
    // window, not a stuck one.
    return [];
  }
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

  return withTimeout(scan(input, address, cp, now), SCAN_TIMEOUT_MS, {
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
  let latest: bigint;
  try {
    latest = await getPublicClient().getBlockNumber();
  } catch {
    return { scanned: false, deposits: 0, withdrawals: 0 };
  }

  // First sight of this wallet (or a previous first attempt that never got a
  // block number): record where we are and notify nothing.
  if (!cp?.lastBlock) {
    await writeCheckpoint(input.merchantId, address, { lastBlock: latest.toString(), lastScanAt: now });
    return { scanned: true, deposits: 0, withdrawals: 0, baseline: true };
  }

  const since = BigInt(cp.lastBlock);
  if (latest <= since) {
    await writeCheckpoint(input.merchantId, address, { lastBlock: latest.toString(), lastScanAt: now });
    return { scanned: true, deposits: 0, withdrawals: 0, nativeComplete: true };
  }
  const fromBlock = latest - since > MAX_SCAN_BLOCKS ? latest - MAX_SCAN_BLOCKS : since + 1n;

  const [incoming, outgoing, native] = await Promise.all([
    pullTransfers("to", address, fromBlock, latest),
    pullTransfers("from", address, fromBlock, latest),
    pullNativeTransfers(address, fromBlock, latest),
  ]);

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
    // A self-transfer shows up in both log directions; drop it before it can
    // be counted as either a deposit or a withdrawal.
  ].filter((d) => d.txHash && d.value > 0n);

  const selfTransfers = new Set(
    incoming
      .filter((l) => l.args?.from?.toLowerCase() === l.args?.to?.toLowerCase())
      .map((l) => (l.transactionHash ?? "").toLowerCase()),
  );

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
          ? `${pretty} arrived in your wallet.`
          : `${pretty} left your wallet in a transaction not made through PayAI.`,
      amount,
      token: symbol,
      txHash: d.txHash,
      explorerUrl: explorerTx(d.txHash),
    }).catch(() => {});
    if (d.direction === "in") deposits++;
    else withdrawals++;
  }

  await writeCheckpoint(input.merchantId, address, { lastBlock: latest.toString(), lastScanAt: now });
  return { scanned: true, deposits, withdrawals, nativeComplete: native.complete };
}
