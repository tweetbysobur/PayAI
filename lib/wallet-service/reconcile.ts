/**
 * Deposit / withdrawal reconciliation — turns real on-chain transfers into
 * wallet notifications.
 *
 * PayAI has no indexer, so this is a bounded, throttled catch-up scan rather
 * than a live watcher: each wallet carries a block checkpoint, and a scan
 * reports only ERC-20 Transfer logs in the range since that checkpoint.
 * Every notification therefore corresponds to a log that really exists, with
 * its real txHash and amount — nothing is inferred from balance deltas.
 *
 * Two deliberate limitations, both reported rather than papered over (same
 * convention as lib/monad/wallet-intel.ts):
 *
 *   - **Native MON deposits are not detected.** A native transfer emits no
 *     log, so `eth_getLogs` cannot see it, and the only alternative — diffing
 *     the account balance — cannot distinguish a deposit from gas refunds or
 *     attribute a txHash. Inventing a "deposit" from a balance delta would be
 *     exactly the fabricated data this codebase forbids. ERC-20 deposits
 *     (USDC and every other token) are detected in full.
 *   - **The first scan only establishes a baseline.** It records no events,
 *     otherwise a wallet with years of history would fire hundreds of
 *     "deposit received" notifications the first time its owner signed in.
 *
 * Server-only.
 */
import "server-only";
import { parseAbiItem, formatUnits } from "viem";
import { getPublicClient } from "@/lib/monad/wallet";
import { explorerTx } from "@/lib/monad/config";
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

export interface ReconcileResult {
  scanned: boolean;
  deposits: number;
  withdrawals: number;
  /** True on the very first scan for a wallet, which only sets the baseline. */
  baseline?: boolean;
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
    return { scanned: true, deposits: 0, withdrawals: 0 };
  }
  const fromBlock = latest - since > MAX_SCAN_BLOCKS ? latest - MAX_SCAN_BLOCKS : since + 1n;

  const [incoming, outgoing] = await Promise.all([
    pullTransfers("to", address, fromBlock, latest),
    pullTransfers("from", address, fromBlock, latest),
  ]);

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

  let deposits = 0;
  let withdrawals = 0;

  for (const [direction, logs] of [["in", incoming], ["out", outgoing]] as const) {
    for (const log of logs) {
      const txHash = log.transactionHash?.toLowerCase();
      const value = log.args?.value;
      if (!txHash || value == null || alreadyRecorded.has(txHash)) continue;
      // A self-transfer appears in both directions; count it once, as neither
      // a deposit nor a withdrawal in any meaningful sense.
      if (log.args?.from?.toLowerCase() === log.args?.to?.toLowerCase()) continue;
      if (direction === "out" && ownTxHashes.has(txHash)) continue;

      let symbol = "tokens";
      let amount: number | null = null;
      try {
        const token = await resolveToken(log.address);
        symbol = token.symbol;
        amount = Number(formatUnits(value, token.decimals));
      } catch {
        // Unresolvable token metadata — still a real transfer worth
        // reporting, just without a formatted amount. Never invent one.
      }

      const pretty = amount != null ? `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}` : symbol;
      alreadyRecorded.add(txHash);
      await recordWalletEvent({
        merchantId: input.merchantId,
        sender: address,
        providerId: input.providerId,
        type: direction === "in" ? "deposit_received" : "withdrawal_completed",
        title: direction === "in" ? "Deposit received" : "Withdrawal completed",
        detail:
          direction === "in"
            ? `${pretty} arrived in your wallet.`
            : `${pretty} left your wallet in a transaction not made through PayAI.`,
        amount,
        token: symbol,
        txHash,
        explorerUrl: explorerTx(txHash),
      }).catch(() => {});
      if (direction === "in") deposits++;
      else withdrawals++;
    }
  }

  await writeCheckpoint(input.merchantId, address, { lastBlock: latest.toString(), lastScanAt: now });
  return { scanned: true, deposits, withdrawals };
}
