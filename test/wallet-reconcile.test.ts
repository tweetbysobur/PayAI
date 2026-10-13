import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/* The reconciler's only external inputs are the chain (getLogs /
   getBlockNumber), the token registry, and PayAI's own tx log. Stub all
   three so the tests exercise the real decision logic — what counts as a
   deposit, what's skipped as already-notified, what the first scan does. */

let latestBlock = 1000n;
let incoming: unknown[] = [];
let outgoing: unknown[] = [];
let ownTxs: { txHash?: string }[] = [];
/** Native transactions, keyed by block number, as block bodies would carry them. */
let nativeTxsByBlock: Record<string, unknown[]> = {};
let blocksRead: string[] = [];
/** null = RPC has no debug_traceBlockByNumber (the common case). */
let traceByBlock: Record<string, unknown[]> | null = null;
let balances: Record<string, bigint> = {};
let receipts: Record<string, { gasUsed: bigint; effectiveGasPrice: bigint }> = {};
const trackedTokens: string[] = [];

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    getBlockNumber: async () => latestBlock,
    getLogs: async ({ args }: { args: Record<string, string> }) =>
      "to" in args ? incoming : outgoing,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      blocksRead.push(blockNumber.toString());
      return { number: blockNumber, transactions: nativeTxsByBlock[blockNumber.toString()] ?? [] };
    },
    getBalance: async ({ blockNumber }: { blockNumber: bigint }) => {
      const v = balances[blockNumber.toString()];
      if (v === undefined) throw new Error("no archive state");
      return v;
    },
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = receipts[hash.toLowerCase()];
      if (!r) throw new Error("no receipt");
      return r;
    },
    request: async ({ method, params }: { method: string; params: unknown[] }) => {
      if (method !== "debug_traceBlockByNumber") throw new Error("unsupported");
      if (traceByBlock === null) throw new Error("the method debug_traceBlockByNumber does not exist");
      const block = BigInt(params[0] as string).toString();
      return traceByBlock[block] ?? [];
    },
  }),
}));
vi.mock("@/lib/monad/config", () => ({
  explorerTx: (h: string) => `https://explorer.monad.xyz/tx/${h}`,
  getChain: () => ({ nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 } }),
}));
vi.mock("@/lib/monad/tokenRegistry", () => ({
  resolveToken: async () => ({ address: "0xtok", symbol: "USDC", name: "USD Coin", decimals: 6, verified: true }),
  trackedTokenAddresses: () => trackedTokens,
}));
vi.mock("@/lib/platform/store", () => ({
  listTx: async () => ownTxs,
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function transferLog(txHash: string, from: string, to: string, value = 5_000_000n) {
  return { transactionHash: txHash, blockNumber: 1001n, address: "0xtok", args: { from, to, value } };
}

/** A native MON transfer as it appears in a block body — no log, just a
 *  transaction carrying `value`. */
function nativeTx(txHash: string, from: string, to: string | null, value = 2_000000000000000000n) {
  return { hash: txHash, from, to, value };
}

async function fresh() {
  vi.resetModules();
  (globalThis as Record<string, unknown>).__payaiWalletScan = undefined;
  (globalThis as Record<string, unknown>).__payaiWalletEvents = undefined;
  const reconcile = await import("@/lib/wallet-service/reconcile");
  const events = await import("@/lib/platform/walletEvents");
  return { ...reconcile, ...events };
}

const run = (fn: (m: Awaited<ReturnType<typeof fresh>>) => Promise<void>) => async () => {
  const m = await fresh();
  await fn(m);
};

describe("wallet transfer reconciliation", () => {
  beforeEach(() => {
    latestBlock = 1000n;
    incoming = [];
    outgoing = [];
    ownTxs = [];
    nativeTxsByBlock = {};
    blocksRead = [];
    traceByBlock = null;
    balances = {};
    receipts = {};
  });
  afterEach(() => vi.useRealTimers());

  it("first scan looks back a short window, catching a deposit from just before it", run(async (m) => {
    // Not a blank baseline: a deposit that landed moments before someone's
    // very first dashboard visit must still be caught, or it silently never
    // notifies at all.
    incoming = [transferLog("0xaaa", OTHER, WALLET)];
    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });

    expect(r.baseline).toBe(true);
    expect(r.deposits).toBe(1);
    const events = await m.listWalletEvents("demo", WALLET);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("deposit_received");
  }));

  it("first scan does not reach back far enough to replay a wallet's whole history", run(async (m) => {
    // A native transfer at a block well outside the lookback window --
    // latestBlock is 1000n, the window only reaches back to ~700n -- must
    // not surface on the very first scan, or a dormant wallet would flood a
    // new user with old activity the moment they first connect.
    nativeTxsByBlock["100"] = [nativeTx("0xold", OTHER, WALLET)];
    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });

    expect(r.baseline).toBe(true);
    expect(r.deposits).toBe(0);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(0);
  }));

  it("records a real incoming transfer as a deposit, with its txHash", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" }); // baseline
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1100n;
    incoming = [transferLog("0xdep", OTHER, WALLET)];
    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });

    expect(r.deposits).toBe(1);
    const [evt] = await m.listWalletEvents("demo", WALLET);
    expect(evt.type).toBe("deposit_received");
    expect(evt.txHash).toBe("0xdep");
    expect(evt.amount).toBe(5);
    expect(evt.token).toBe("USDC");
  }));

  it("detects a native MON deposit, which emits no log at all", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1010n;
    // Deliberately NO Transfer log — a native send produces none. If this is
    // detected, it came from reading the block body.
    nativeTxsByBlock["1005"] = [nativeTx("0xnative", OTHER, WALLET)];

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(1);
    expect(r.nativeComplete).toBe(true);

    const [evt] = await m.listWalletEvents("demo", WALLET);
    expect(evt.type).toBe("deposit_received");
    expect(evt.txHash).toBe("0xnative");
    expect(evt.token).toBe("MON");
    expect(evt.amount).toBe(2); // 2e18 wei at 18 decimals
  }));

  it("ignores a zero-value contract call and a transfer between strangers", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1010n;
    nativeTxsByBlock["1005"] = [
      nativeTx("0xcall", OTHER, WALLET, 0n), // a call, not a transfer
      nativeTx("0xstranger", OTHER, "0x9999999999999999999999999999999999999999"), // not ours
      nativeTx("0xselfnative", WALLET, WALLET), // self-transfer
    ];

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits + r.withdrawals).toBe(0);
  }));

  it("reports a native send PayAI didn't make as a withdrawal, but skips one it did", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1010n;
    nativeTxsByBlock["1004"] = [nativeTx("0xmine", WALLET, OTHER)];
    nativeTxsByBlock["1005"] = [nativeTx("0xtheirs", WALLET, OTHER)];
    ownTxs = [{ txHash: "0xmine" }];

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.withdrawals).toBe(1);
    const evts = await m.listWalletEvents("demo", WALLET);
    expect(evts).toHaveLength(1);
    expect(evts[0].txHash).toBe("0xtheirs");
  }));

  it("skips native detection on a window too wide to read block-by-block, and says so", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    blocksRead = []; // only the next scan's reads matter here, not the baseline's own lookback window

    latestBlock = 40_000n; // ~39k blocks since the checkpoint, far past the cap
    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });

    expect(r.nativeComplete).toBe(false);
    // Crucially it did NOT try to read 39,000 blocks.
    expect(blocksRead).toHaveLength(0);
  }));

  it("reads only the blocks since the checkpoint, not the whole chain", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    blocksRead = []; // only the next scan's reads matter here, not the baseline's own lookback window

    latestBlock = 1005n; // checkpoint was 1000 → expect 1001..1005
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(blocksRead.sort()).toEqual(["1001", "1002", "1003", "1004", "1005"]);
  }));

  it("does not double-notify a send PayAI already recorded as a payment", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1100n;
    outgoing = [transferLog("0xPAYAI", WALLET, OTHER)];
    ownTxs = [{ txHash: "0xpayai" }]; // tx log casing differs — must still match

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.withdrawals).toBe(0);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(0);
  }));

  it("reports an outgoing transfer PayAI did not make as a withdrawal", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1100n;
    outgoing = [transferLog("0xext", WALLET, OTHER)];
    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });

    expect(r.withdrawals).toBe(1);
    expect((await m.listWalletEvents("demo", WALLET))[0].type).toBe("withdrawal_completed");
  }));

  it("ignores a self-transfer rather than counting it twice", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1100n;
    const self = transferLog("0xself", WALLET, WALLET);
    incoming = [self];
    outgoing = [self];

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits + r.withdrawals).toBe(0);
  }));

  it("never records the same transfer twice across scans", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1100n;
    incoming = [transferLog("0xdup", OTHER, WALLET)];
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });

    // Same log surfaces again (e.g. an RPC replaying an overlapping range).
    vi.advanceTimersByTime(61_000);
    latestBlock = 1200n;
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });

    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(1);
  }));

  it("throttles: a second call inside the window does not re-scan", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    latestBlock = 1100n;
    incoming = [transferLog("0xthrottled", OTHER, WALLET)];

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.scanned).toBe(false);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(0);
  }));

  it("gives up on a hanging RPC instead of holding the notification feed open", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    // An RPC that never answers at all.
    const spy = vi.spyOn(await import("@/lib/monad/wallet"), "getPublicClient").mockReturnValue({
      getBlockNumber: () => new Promise(() => {}),
      getLogs: () => new Promise(() => {}),
    } as never);

    const pending = m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    await vi.advanceTimersByTimeAsync(8_500);
    const r = await pending;

    expect(r.scanned).toBe(false);
    spy.mockRestore();

    // And the failed attempt is throttled, so the next poll doesn't
    // immediately start another doomed scan.
    const immediate = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(immediate.scanned).toBe(false);
  }));

  it("degrades to no deposits when the chain is unreachable", run(async (m) => {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    latestBlock = 1100n;
    incoming = [transferLog("0xboom", OTHER, WALLET)];
    // getLogs throwing is caught inside pullTransfers; simulate via a getter.
    const spy = vi.spyOn(await import("@/lib/monad/wallet"), "getPublicClient").mockReturnValue({
      getBlockNumber: async () => { throw new Error("RPC down"); },
      getLogs: async () => { throw new Error("RPC down"); },
    } as never);

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.scanned).toBe(false);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(0);
    spy.mockRestore();
  }));
});

/**
 * MON paid out from inside a contract — a DEX settling a swap, unwrapping
 * WMON, a refund — moves value with no top-level transaction and no log, so
 * neither the log scan nor the block-body scan can see it.
 */
describe("internal (contract-originated) native transfers", () => {
  beforeEach(() => {
    latestBlock = 1000n;
    incoming = []; outgoing = []; ownTxs = [];
    nativeTxsByBlock = {}; blocksRead = [];
    traceByBlock = null; balances = {}; receipts = {};
  });
  afterEach(() => vi.useRealTimers());

  async function baselineThenAdvance(m: Awaited<ReturnType<typeof fresh>>) {
    await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
  }

  it("finds one via tracing, with the real transaction, when the RPC supports it", run(async (m) => {
    // The baseline scan's own lookback window is wide enough to trigger the
    // trace probe itself, so the RPC needs to look supported from the start
    // (an empty response is still a valid, tracing-capable shape) — otherwise
    // the probe would run against traceByBlock = null and latch "unsupported"
    // before this test's real scenario ever gets to it.
    traceByBlock = {};
    await baselineThenAdvance(m);
    latestBlock = 1002n;
    // A swap: the wallet's own call in, MON handed back by an inner call.
    traceByBlock["1001"] = [{
      txHash: "0xSWAP",
      result: {
        from: WALLET, to: "0xdex000000000000000000000000000000000000dex", value: "0x0",
        calls: [{ from: "0xdex000000000000000000000000000000000000dex", to: WALLET, value: "0x1bc16d674ec80000" }], // 2e18
      },
    }];

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(1);
    const [evt] = await m.listWalletEvents("demo", WALLET);
    expect(evt.txHash).toBe("0xswap");
    expect(evt.amount).toBe(2);
    expect(evt.token).toBe("MON");
    expect(evt.explorerUrl).toContain("0xswap"); // a real tx, so a real link
  }));

  it("reports a plain transfer once, even when tracing sees it as well", run(async (m) => {
    await baselineThenAdvance(m);
    latestBlock = 1002n;
    nativeTxsByBlock["1001"] = [nativeTx("0xplain", OTHER, WALLET)];
    // The same transfer also surfaces as the outermost trace call. Two things
    // stop it being reported twice — the trace walk skips depth 0, and the
    // txHash dedupe catches anything that slips past — and this asserts the
    // observable result of both.
    (traceByBlock ??= {})["1001"] = [{
      txHash: "0xplain",
      result: { from: OTHER, to: WALLET, value: "0x1bc16d674ec80000" },
    }];

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(1);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(1);
  }));

  it("falls back to exact balance reconciliation when tracing is unavailable", run(async (m) => {
    await baselineThenAdvance(m);
    latestBlock = 1002n;
    traceByBlock = null; // RPC has no debug_* — the common case
    // Balance rose 3 MON with no top-level transfer to explain it.
    balances["1000"] = 10_000000000000000000n;
    balances["1002"] = 13_000000000000000000n;

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(1);
    const [evt] = await m.listWalletEvents("demo", WALLET);
    expect(evt.amount).toBe(3);
    expect(evt.token).toBe("MON");
    expect(evt.detail).toMatch(/from a contract/i);
    // No transaction can be attributed, so it must not fake an explorer link.
    expect(evt.explorerUrl).toBeUndefined();
    expect(evt.txHash).toMatch(/^internal:/);
  }));

  it("subtracts top-level transfers, so a normal deposit isn't counted twice", run(async (m) => {
    await baselineThenAdvance(m);
    latestBlock = 1002n;
    nativeTxsByBlock["1001"] = [nativeTx("0xtop", OTHER, WALLET)]; // 2 MON in
    balances["1000"] = 10_000000000000000000n;
    balances["1002"] = 12_000000000000000000n; // rise fully explained by 0xtop

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(1); // the top-level one only
    const evts = await m.listWalletEvents("demo", WALLET);
    expect(evts).toHaveLength(1);
    expect(evts[0].txHash).toBe("0xtop");
  }));

  it("subtracts gas, so the reported amount is the deposit and not the fee too", run(async (m) => {
    await baselineThenAdvance(m);
    latestBlock = 1002n;
    // The wallet sent 1 MON, burned exactly 0.01 MON of gas, and received
    // 4 MON from a contract: 10 − 1 − 0.01 + 4 = 12.99.
    nativeTxsByBlock["1001"] = [nativeTx("0xsend", WALLET, OTHER, 1_000000000000000000n)];
    receipts["0xsend"] = { gasUsed: 20_000n, effectiveGasPrice: 500_000_000_000n }; // 1e16 wei = exactly 0.01 MON
    balances["1000"] = 10_000000000000000000n;
    balances["1002"] = 12_990000000000000000n;

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(1);
    const dep = (await m.listWalletEvents("demo", WALLET)).find((e) => e.type === "deposit_received");
    // Must be exactly 4. Forgetting to subtract gas would report 3.99 — the
    // fee silently folded into the user's "deposit".
    expect(dep?.amount).toBe(4);
  }));

  it("reports nothing when the balance is unchanged", run(async (m) => {
    await baselineThenAdvance(m);
    latestBlock = 1002n;
    balances["1000"] = 5_000000000000000000n;
    balances["1002"] = 5_000000000000000000n;

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(0);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(0);
  }));

  it("invents nothing when archive state is unavailable", run(async (m) => {
    await baselineThenAdvance(m);
    latestBlock = 1002n;
    balances = {}; // getBalance throws — a non-archive node
    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(0);
    expect(await m.listWalletEvents("demo", WALLET)).toHaveLength(0);
  }));

  it("invents nothing when a receipt is missing, rather than over-reporting", run(async (m) => {
    await baselineThenAdvance(m);
    latestBlock = 1002n;
    nativeTxsByBlock["1001"] = [nativeTx("0xsend", WALLET, OTHER, 1_000000000000000000n)];
    // No receipt for 0xsend => gas unknown. Treating it as zero would make the
    // residual look positive and invent a deposit that never happened.
    balances["1000"] = 10_000000000000000000n;
    balances["1002"] = 8_990000000000000000n;

    const r = await m.reconcileWalletTransfers({ merchantId: "demo", address: WALLET, providerId: "injected" });
    expect(r.deposits).toBe(0);
  }));
});
