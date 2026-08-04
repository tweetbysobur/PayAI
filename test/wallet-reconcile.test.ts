import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/* The reconciler's only external inputs are the chain (getLogs /
   getBlockNumber), the token registry, and PayAI's own tx log. Stub all
   three so the tests exercise the real decision logic — what counts as a
   deposit, what's skipped as already-notified, what the first scan does. */

let latestBlock = 1000n;
let incoming: unknown[] = [];
let outgoing: unknown[] = [];
let ownTxs: { txHash?: string }[] = [];

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    getBlockNumber: async () => latestBlock,
    getLogs: async ({ args }: { args: Record<string, string> }) =>
      "to" in args ? incoming : outgoing,
  }),
}));
vi.mock("@/lib/monad/config", () => ({
  explorerTx: (h: string) => `https://explorer.monad.xyz/tx/${h}`,
}));
vi.mock("@/lib/monad/tokenRegistry", () => ({
  resolveToken: async () => ({ address: "0xtok", symbol: "USDC", name: "USD Coin", decimals: 6, verified: true }),
}));
vi.mock("@/lib/platform/store", () => ({
  listTx: async () => ownTxs,
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function transferLog(txHash: string, from: string, to: string, value = 5_000_000n) {
  return { transactionHash: txHash, blockNumber: 1001n, address: "0xtok", args: { from, to, value } };
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
  });
  afterEach(() => vi.useRealTimers());

  it("first scan only sets a baseline — never replays a wallet's whole history", run(async (m) => {
    incoming = [transferLog("0xaaa", OTHER, WALLET)];
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
