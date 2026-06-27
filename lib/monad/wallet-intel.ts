/**
 * Wallet Intelligence — real on-chain data for a connected user wallet.
 *
 * Everything here is either a direct RPC read (balance, nonce) or derived from
 * PaymentExecutor's own `PaymentExecuted` logs filtered to this address (via
 * indexed `agent`/`merchant` topics, so each event carries its real txHash and
 * block number). Metrics that would require a block-explorer indexer we don't
 * have API access to (full chain-wide tx count, wallet "age" from first-ever tx,
 * reverse ENS-style domain lookup) are reported as unavailable rather than
 * estimated — no fabricated numbers.
 */
import "server-only";
import { formatEther, formatUnits } from "viem";
import { getPublicClient } from "./wallet";
import { getPaymentExecutor, getStablecoin, explorerTx, explorerAddress, getChain } from "./config";
import { PAYMENT_EXECUTOR_ABI } from "./abi";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface WalletPaymentEvent {
  paymentId: number;
  direction: "sent" | "received";
  counterparty: `0x${string}`;
  amount: number;
  token: string;
  riskScore: number;
  txHash: string;
  blockNumber: number;
  timestamp: number | null;
  explorerUrl: string;
}

export interface WalletIntelligence {
  address: `0x${string}`;
  network: string;
  chainId: number;
  explorerAddressUrl: string;
  nativeBalance: string;
  usdcBalance: string;
  monPriceUsd: number | null;
  totalValueUsd: number | null;
  txCountSent: number;
  paymentsSent: number;
  paymentsReceived: number;
  volumeSent: number;
  volumeReceived: number;
  lifetimeVolume: number;
  monthlyVolume: number;
  largestTx: number;
  averageTx: number;
  gasSpentMon: number | null;
  events: WalletPaymentEvent[];
  domain: string | null;
  insights: string;
}

async function fetchMonPriceUsd(): Promise<number | null> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd", {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.monad?.usd === "number" ? j.monad.usd : null;
  } catch {
    return null;
  }
}

/** Pull every PaymentExecuted log involving this address, in either role, with real tx/block data. */
async function fetchPaymentEvents(address: `0x${string}`): Promise<WalletPaymentEvent[]> {
  const executor = getPaymentExecutor();
  if (!executor) return [];
  const pub = getPublicClient();
  const token = getStablecoin();
  const event = PAYMENT_EXECUTOR_ABI.find((e) => e.type === "event" && e.name === "PaymentExecuted")!;
  const executorAddr: `0x${string}` = executor;

  interface RawLog {
    transactionHash: `0x${string}` | null;
    logIndex: number | null;
    blockNumber: bigint | null;
    args: unknown;
  }

  async function pull(role: "agent" | "merchant"): Promise<RawLog[]> {
    try {
      return (await pub.getLogs({
        address: executorAddr,
        event: event as never,
        args: { [role]: address } as never,
        fromBlock: "earliest",
        toBlock: "latest",
      })) as unknown as RawLog[];
    } catch {
      // Full-range scan failed (RPC block-range limit) — fall back to the most recent ~50k blocks.
      try {
        const latest = await pub.getBlockNumber();
        const from = latest > 50_000n ? latest - 50_000n : 0n;
        return (await pub.getLogs({
          address: executorAddr, event: event as never, args: { [role]: address } as never,
          fromBlock: from, toBlock: "latest",
        })) as unknown as RawLog[];
      } catch {
        return [];
      }
    }
  }

  const [sentLogs, receivedLogs] = await Promise.all([pull("agent"), pull("merchant")]);
  const merged = [...sentLogs.map((l) => ({ l, direction: "sent" as const })), ...receivedLogs.map((l) => ({ l, direction: "received" as const }))];

  // De-dup (a self-pay would show in both lists) and resolve block timestamps for the unique blocks involved.
  const seen = new Set<string>();
  const unique = merged.filter(({ l }) => {
    const key = `${l.transactionHash}-${l.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const blockNumbers = Array.from(new Set(unique.map(({ l }) => l.blockNumber).filter((b): b is bigint => b != null)));
  const blocks = await Promise.all(
    blockNumbers.map(async (bn) => {
      try {
        const b = await pub.getBlock({ blockNumber: bn });
        return [bn, Number(b.timestamp) * 1000] as const;
      } catch {
        return [bn, null] as const;
      }
    }),
  );
  const tsByBlock = new Map(blocks);

  return unique
    .map(({ l, direction }) => {
      const args = l.args as unknown as { id: bigint; agent: `0x${string}`; merchant: `0x${string}`; token: `0x${string}`; amount: bigint; riskScore: number };
      return {
        paymentId: Number(args.id),
        direction,
        counterparty: direction === "sent" ? args.merchant : args.agent,
        amount: Number(args.amount) / 10 ** token.decimals,
        token: token.symbol,
        riskScore: Number(args.riskScore),
        txHash: l.transactionHash ?? "",
        blockNumber: l.blockNumber != null ? Number(l.blockNumber) : 0,
        timestamp: l.blockNumber != null ? tsByBlock.get(l.blockNumber) ?? null : null,
        explorerUrl: l.transactionHash ? explorerTx(l.transactionHash) : "",
      };
    })
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

function buildInsights(w: Omit<WalletIntelligence, "insights">): string {
  const parts: string[] = [];
  if (w.paymentsSent === 0 && w.paymentsReceived === 0) {
    parts.push("This wallet hasn't sent or received any payments through PayAI yet — once it does, this section will summarize real activity.");
  } else {
    if (w.paymentsSent > 0) parts.push(`Sent ${w.paymentsSent} payment${w.paymentsSent === 1 ? "" : "s"} totaling ${w.volumeSent.toFixed(2)} USDC.`);
    if (w.paymentsReceived > 0) parts.push(`Received ${w.paymentsReceived} payment${w.paymentsReceived === 1 ? "" : "s"} totaling ${w.volumeReceived.toFixed(2)} USDC.`);
    if (w.monthlyVolume > 0) parts.push(`${w.monthlyVolume.toFixed(2)} USDC of that moved in the last 30 days.`);
    if (w.largestTx > 0) parts.push(`The largest single transaction was ${w.largestTx.toFixed(2)} USDC.`);
  }
  if (Number(w.nativeBalance) > 0 || Number(w.usdcBalance) > 0) {
    parts.push(`Currently holding ${Number(w.nativeBalance).toFixed(4)} MON and ${Number(w.usdcBalance).toFixed(2)} USDC.`);
  }
  return parts.join(" ");
}

export async function getWalletIntelligence(address: `0x${string}`): Promise<WalletIntelligence> {
  const pub = getPublicClient();
  const chain = getChain();
  const token = getStablecoin();

  const [nativeBalanceWei, usdcBalanceRaw, txCountSent, monPriceUsd, events] = await Promise.all([
    pub.getBalance({ address }).catch(() => 0n),
    token.address !== "0x0000000000000000000000000000000000000000"
      ? (pub.readContract({ address: token.address, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>).catch(() => 0n)
      : Promise.resolve(0n),
    pub.getTransactionCount({ address }).catch(() => 0),
    fetchMonPriceUsd(),
    fetchPaymentEvents(address),
  ]);

  const nativeBalance = formatEther(nativeBalanceWei);
  const usdcBalance = formatUnits(usdcBalanceRaw, token.decimals);
  const totalValueUsd = monPriceUsd != null ? Number(nativeBalance) * monPriceUsd + Number(usdcBalance) : null;

  const sent = events.filter((e) => e.direction === "sent");
  const received = events.filter((e) => e.direction === "received");
  const volumeSent = sent.reduce((s, e) => s + e.amount, 0);
  const volumeReceived = received.reduce((s, e) => s + e.amount, 0);
  const lifetimeVolume = volumeSent + volumeReceived;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const monthlyVolume = events.filter((e) => (e.timestamp ?? 0) >= thirtyDaysAgo).reduce((s, e) => s + e.amount, 0);
  const largestTx = events.reduce((m, e) => Math.max(m, e.amount), 0);
  const averageTx = events.length > 0 ? lifetimeVolume / events.length : 0;

  // Gas actually paid by this wallet, summed from the receipts of txs it sent (capped to bound RPC calls).
  const ownTxHashes = Array.from(new Set(sent.map((e) => e.txHash).filter(Boolean))).slice(0, 30);
  let gasSpentMon: number | null = null;
  if (ownTxHashes.length > 0) {
    try {
      const receipts = await Promise.all(ownTxHashes.map((h) => pub.getTransactionReceipt({ hash: h as `0x${string}` }).catch(() => null)));
      const totalWei = receipts.reduce((s, r) => (r ? s + r.gasUsed * r.effectiveGasPrice : s), 0n);
      gasSpentMon = Number(formatEther(totalWei));
    } catch {
      gasSpentMon = null;
    }
  } else if (sent.length === 0) {
    gasSpentMon = 0;
  }

  const base = {
    address, network: chain.name, chainId: chain.id, explorerAddressUrl: explorerAddress(address),
    nativeBalance, usdcBalance, monPriceUsd, totalValueUsd,
    txCountSent, paymentsSent: sent.length, paymentsReceived: received.length,
    volumeSent, volumeReceived, lifetimeVolume, monthlyVolume, largestTx, averageTx,
    gasSpentMon, events: events.slice(0, 25), domain: null,
  };

  return { ...base, insights: buildInsights(base) };
}
