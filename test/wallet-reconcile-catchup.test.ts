import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/* Deposits that land while nobody has the dashboard open. The gap since the
   last scan is then far wider than Monad's RPC will return logs for (100
   blocks), so the reconciler follows balances instead. This mock is a small
   chain: balances are derived from the same transfers the block bodies and
   logs report, so every read agrees with every other, as on a real node. */

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const DEX = "0x3333333333333333333333333333333333333333";
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";

interface Move {
  block: bigint;
  /** null = MON. */
  token: string | null;
  from: string;
  to: string;
  value: bigint;
  hash: string;
  /** Paid out from inside a contract: changes the balance, no top-level tx. */
  internal?: boolean;
}

let latestBlock = 0n;
let moves: Move[] = [];
let gas: Record<string, bigint> = {};
let reads = 0;
/** Fake milliseconds each RPC read takes, to exercise the time budget. */
let readCostMs = 0;
let logRangeRequests: bigint[] = [];

function tick() {
  reads++;
  if (readCostMs) vi.advanceTimersByTime(readCostMs);
}

function balance(token: string | null, at: bigint): bigint {
  let b = 1_000n * 10n ** 18n;
  for (const m of moves) {
    if (m.block > at || m.token !== token) continue;
    if (m.to === WALLET) b += m.value;
    if (m.from === WALLET) b -= m.value;
  }
  if (token === null) {
    for (const m of moves) if (m.block <= at && m.from === WALLET && gas[m.hash]) b -= gas[m.hash];
  }
  return b;
}

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    getBlockNumber: async () => latestBlock,
    getBalance: async ({ blockNumber }: { blockNumber: bigint }) => { tick(); return balance(null, blockNumber); },
    readContract: async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
      tick();
      return balance(address.toLowerCase(), blockNumber);
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      tick();
      return {
        number: blockNumber,
        transactions: moves
          .filter((m) => m.token === null && !m.internal && m.block === blockNumber)
          .map((m) => ({ hash: m.hash, from: m.from, to: m.to, value: m.value })),
      };
    },
    getLogs: async ({ address, args, fromBlock, toBlock }: { address?: string; args: Record<string, string>; fromBlock: bigint; toBlock: bigint }) => {
      tick();
      logRangeRequests.push(toBlock - fromBlock + 1n);
      if (toBlock - fromBlock + 1n > 100n) throw new Error("eth_getLogs is limited to a 100 range");
      const role = "to" in args ? "to" : "from";
      return moves
        .filter((m) => m.token !== null && m.block >= fromBlock && m.block <= toBlock)
        .filter((m) => !address || m.token === address.toLowerCase())
        .filter((m) => m[role] === args[role].toLowerCase())
        .map((m) => ({ transactionHash: m.hash, blockNumber: m.block, address: m.token, args: { from: m.from, to: m.to, value: m.value } }));
    },
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      tick();
      if (gas[hash] === undefined) throw new Error("no receipt");
      return { gasUsed: gas[hash], effectiveGasPrice: 1n };
    },
    request: async () => { throw new Error("the method debug_traceBlockByNumber does not exist"); },
  }),
}));
vi.mock("@/lib/monad/config", () => ({
  explorerTx: (h: string) => `https://explorer.monad.xyz/tx/${h}`,
  getChain: () => ({ nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 } }),
}));
vi.mock("@/lib/monad/tokenRegistry", () => ({
  resolveToken: async () => ({ address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, verified: true }),
  trackedTokenAddresses: () => [USDC],
}));
let ownTxs: { txHash?: string }[] = [];
vi.mock("@/lib/platform/store", () => ({ listTx: async () => ownTxs }));

async function fresh() {
  vi.resetModules();
  (globalThis as Record<string, unknown>).__payaiWalletScan = undefined;
  (globalThis as Record<string, unknown>).__payaiWalletEvents = undefined;
  const reconcile = await import("@/lib/wallet-service/reconcile");
  const events = await import("@/lib/platform/walletEvents");
  return { ...reconcile, ...events };
}
type M = Awaited<ReturnType<typeof fresh>>;

const scanOnce = (m: M) => m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "mera" });

/** First visit at block 1,000,000, then the user leaves for ~a day. */
async function visitThenLeave(m: M, away = 300_000n) {
  latestBlock = 1_000_000n;
  await scanOnce(m);
  vi.advanceTimersByTime(61_000);
  latestBlock = 1_000_000n + away;
  reads = 0;
}

const MON = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

describe("deposits made while the dashboard was closed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latestBlock = 0n; moves = []; gas = {}; reads = 0; readCostMs = 0; ownTxs = []; logRangeRequests = [];
  });
  afterEach(() => vi.useRealTimers());

  it("finds a MON deposit from hours ago, with its transaction", async () => {
    const m = await fresh();
    await visitThenLeave(m);
    moves.push({ block: 1_123_457n, token: null, from: OTHER, to: WALLET, value: MON(25), hash: "0xmon" });

    const r = await scanOnce(m);
    expect(r.deposits).toBe(1);
    expect(r.nativeComplete).toBe(true);
    const [evt] = await m.listWalletEvents("demo", WALLET);
    expect(evt.type).toBe("deposit_received");
    expect(evt.txHash).toBe("0xmon");
    expect(evt.amount).toBe(25);
    expect(evt.token).toBe("MON");
    // Bisection, not a block-by-block crawl of 300,000 blocks.
    expect(reads).toBeLessThan(100);
  });

  it("finds a USDC deposit from hours ago without asking the RPC for more than 100 blocks of logs", async () => {
    const m = await fresh();
    await visitThenLeave(m);
    logRangeRequests = [];
    moves.push({ block: 1_200_001n, token: USDC, from: OTHER, to: WALLET, value: 40_000_000n, hash: "0xusdc" });

    const r = await scanOnce(m);
    expect(r.deposits).toBe(1);
    const [evt] = await m.listWalletEvents("demo", WALLET);
    expect(evt.txHash).toBe("0xusdc");
    expect(evt.amount).toBe(40);
    expect(evt.token).toBe("USDC");
    expect(logRangeRequests.every((n) => n <= 100n)).toBe(true);
  });

  it("reports MON paid out by a contract at the exact block, for the exact amount", async () => {
    const m = await fresh();
    await visitThenLeave(m);
    moves.push({ block: 1_050_000n, token: null, from: DEX, to: WALLET, value: MON(3), hash: "0xinner", internal: true });

    const r = await scanOnce(m);
    expect(r.deposits).toBe(1);
    const [evt] = await m.listWalletEvents("demo", WALLET);
    expect(evt.amount).toBe(3);
    expect(evt.txHash).toBe("internal:1050000-1050000");
    expect(evt.explorerUrl).toBeUndefined();
  });

  it("does not mistake the wallet's own gas for anything, and skips sends PayAI made", async () => {
    const m = await fresh();
    await visitThenLeave(m);
    moves.push({ block: 1_010_000n, token: null, from: WALLET, to: OTHER, value: MON(1), hash: "0xpayai" });
    gas["0xpayai"] = MON(0.01);
    moves.push({ block: 1_020_000n, token: null, from: WALLET, to: DEX, value: 0n, hash: "0xcall" });
    gas["0xcall"] = MON(0.02);
    ownTxs = [{ txHash: "0xpayai" }];

    const r = await scanOnce(m);
    expect(r.deposits + r.withdrawals).toBe(0);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(0);
  });

  it("finds a deposit even when a send of the same size happened elsewhere in the gap", async () => {
    const m = await fresh();
    await visitThenLeave(m);
    moves.push({ block: 1_010_000n, token: null, from: OTHER, to: WALLET, value: MON(5), hash: "0xin" });
    moves.push({ block: 1_250_000n, token: null, from: WALLET, to: OTHER, value: MON(5), hash: "0xout" });
    gas["0xout"] = 0n;
    ownTxs = [{ txHash: "0xout" }];

    const r = await scanOnce(m);
    expect(r.deposits).toBe(1);
    expect((await m.listWalletEvents("demo", WALLET))[0].txHash).toBe("0xin");
  });

  it("a catch-up too big for one poll carries on next poll instead of skipping the rest", async () => {
    const m = await fresh();
    await visitThenLeave(m);
    readCostMs = 150; // a slow RPC: one poll can't finish the whole gap
    const deposits = [1_020_000n, 1_090_000n, 1_160_000n, 1_230_000n, 1_290_000n];
    deposits.forEach((block, i) => moves.push({ block, token: null, from: OTHER, to: WALLET, value: MON(i + 1), hash: `0xd${i}` }));

    const first = await scanOnce(m);
    expect(first.scanned).toBe(true);
    expect(first.deposits).toBeLessThan(deposits.length);

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(61_000);
      await scanOnce(m);
    }
    const found = (await m.listWalletEvents("demo", WALLET)).map((e) => e.txHash).sort();
    expect(found).toEqual(["0xd0", "0xd1", "0xd2", "0xd3", "0xd4"]);
  });

  it("never records a deposit twice when a catch-up resumes", async () => {
    const m = await fresh();
    await visitThenLeave(m);
    readCostMs = 150;
    for (let i = 0; i < 4; i++) moves.push({ block: 1_030_000n + BigInt(i) * 70_000n, token: null, from: OTHER, to: WALLET, value: MON(1), hash: `0xr${i}` });
    for (let i = 0; i < 12; i++) {
      await scanOnce(m);
      vi.advanceTimersByTime(61_000);
    }
    const hashes = (await m.listWalletEvents("demo", WALLET)).map((e) => e.txHash);
    expect(hashes).toHaveLength(4);
    expect(new Set(hashes).size).toBe(4);
  });
});

describe("wallets scanned before long gaps were caught up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latestBlock = 0n; moves = []; gas = {}; reads = 0; readCostMs = 0; ownTxs = []; logRangeRequests = [];
  });
  afterEach(() => vi.useRealTimers());

  it("re-reads the last day once, recovering a deposit the old scan skipped", async () => {
    const m = await fresh();
    // The old scan had moved its checkpoint past this deposit without seeing it.
    moves.push({ block: 4_900_000n, token: USDC, from: OTHER, to: WALLET, value: 12_000_000n, hash: "0xmissed" });
    const legacy = `payai:demo:wallet-scan:${WALLET}`;
    ((globalThis as Record<string, unknown>).__payaiWalletScan as Map<string, unknown>).set(legacy, { lastBlock: "5000000", lastScanAt: 0 });
    latestBlock = 5_000_050n;

    const r = await scanOnce(m);
    expect(r.baseline).toBeUndefined();
    expect(r.deposits).toBe(1);
    expect((await m.listWalletEvents("demo", WALLET))[0].txHash).toBe("0xmissed");

    // Once: the next scan carries on from the new checkpoint, no replay.
    vi.advanceTimersByTime(61_000);
    latestBlock = 5_000_100n;
    const again = await scanOnce(m);
    expect(again.deposits).toBe(0);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(1);
  });

  it("a wallet never seen before still starts fresh, without replaying a day", async () => {
    const m = await fresh();
    moves.push({ block: 4_900_000n, token: USDC, from: OTHER, to: WALLET, value: 12_000_000n, hash: "0xold" });
    latestBlock = 5_000_000n;
    const r = await scanOnce(m);
    expect(r.baseline).toBe(true);
    expect(r.deposits).toBe(0);
  });
});
