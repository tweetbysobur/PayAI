import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { viewHoldings, resolveTokenMeta, warmPortfolioDiscovery, type Holding } from "@/lib/hooks/usePortfolio";
import { syncAgo } from "@/lib/hooks/useSync";
import { fetchIncomingTransferLogs } from "@/app/api/portfolio/discover/route";

let getBlockNumberImpl: () => Promise<bigint> = async () => 0n;
let requestImpl: (params: { params: [{ fromBlock: string; toBlock: string }] }) => Promise<{ address: string }[]> = async () => [];
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    getBlockNumber: () => getBlockNumberImpl(),
    request: (params: unknown) => requestImpl(params as never),
  }),
}));

let resolveTokenImpl: (address: string) => Promise<{ address: string; symbol: string; name: string; decimals: number; verified: boolean }> =
  async (address) => ({ address, symbol: "TKN", name: "Token", decimals: 18, verified: false });
vi.mock("@/lib/monad/tokenRegistry", () => ({
  resolveToken: (address: string) => resolveTokenImpl(address),
}));

/** The wallet's own settled trade history — the chain-scan-free half of
 *  discovery (see the route's own doc on why it exists). Empty by default so
 *  every pre-existing test still exercises the scan exactly as before. */
let listTxImpl: () => Promise<{ outputTokenAddress?: string | null }[]> = async () => [];
vi.mock("@/lib/platform/tenant", () => ({ resolveTenantId: async () => "test-tenant" }));
vi.mock("@/lib/platform/store", () => ({ listTx: () => listTxImpl() }));

function h(over: Partial<Holding> = {}): Holding {
  return {
    address: "0x1111111111111111111111111111111111111111",
    symbol: "TKN",
    name: "Token",
    decimals: 18,
    logoURI: null,
    verified: true,
    balance: 1,
    valueUsd: 1,
    native: false,
    ...over,
  };
}

describe("portfolio view", () => {
  it("sorts by value, highest first", () => {
    const rows = viewHoldings([
      h({ symbol: "A", valueUsd: 10 }),
      h({ symbol: "B", valueUsd: 500 }),
      h({ symbol: "C", valueUsd: 90 }),
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["B", "C", "A"]);
  });

  it("ranks an unpriced token below every priced one, rather than treating it as worth zero", () => {
    // "We don't know what this is worth" and "this is worth nothing" are
    // different claims. Sorting an unknown as 0 would bury a real holding
    // beneath dust.
    const rows = viewHoldings([
      h({ symbol: "UNKNOWN", valueUsd: null, balance: 1000 }),
      h({ symbol: "DUST", valueUsd: 0.01 }),
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["DUST", "UNKNOWN"]);
  });

  it("orders unpriced tokens among themselves by balance", () => {
    const rows = viewHoldings([
      h({ symbol: "SMALL", valueUsd: null, balance: 2 }),
      h({ symbol: "BIG", valueUsd: null, balance: 900 }),
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["BIG", "SMALL"]);
  });

  it("hides zero balances when asked", () => {
    const rows = viewHoldings(
      [h({ symbol: "HELD", balance: 5 }), h({ symbol: "EMPTY", balance: 0 })],
      { hideZero: true },
    );
    expect(rows.map((r) => r.symbol)).toEqual(["HELD"]);
  });

  it("keeps the native asset even at zero", () => {
    // "You have 0 MON" is the most actionable thing an empty wallet can say —
    // nothing on this chain works without it, so hiding it hides the reason
    // everything else is failing.
    const rows = viewHoldings(
      [h({ symbol: "MON", balance: 0, native: true }), h({ symbol: "EMPTY", balance: 0 })],
      { hideZero: true },
    );
    expect(rows.map((r) => r.symbol)).toEqual(["MON"]);
  });

  it("searches symbol, name and contract address", () => {
    const list = [
      h({ symbol: "AUSDC", name: "Aave USD Coin", address: "0xaaaa000000000000000000000000000000000001" }),
      h({ symbol: "WMON", name: "Wrapped Monad", address: "0xbbbb000000000000000000000000000000000002" }),
    ];
    expect(viewHoldings(list, { query: "ausd" }).map((r) => r.symbol)).toEqual(["AUSDC"]);
    expect(viewHoldings(list, { query: "wrapped" }).map((r) => r.symbol)).toEqual(["WMON"]);
    expect(viewHoldings(list, { query: "0xbbbb" }).map((r) => r.symbol)).toEqual(["WMON"]);
  });

  it("sorts by name and by balance on request", () => {
    const list = [h({ symbol: "ZED", balance: 1 }), h({ symbol: "ACE", balance: 99 })];
    expect(viewHoldings(list, { sort: "symbol" }).map((r) => r.symbol)).toEqual(["ACE", "ZED"]);
    expect(viewHoldings(list, { sort: "balance" }).map((r) => r.symbol)).toEqual(["ACE", "ZED"]);
  });

  it("does not mutate the list it was given", () => {
    const list = [h({ symbol: "A", valueUsd: 1 }), h({ symbol: "B", valueUsd: 2 })];
    viewHoldings(list);
    expect(list.map((r) => r.symbol)).toEqual(["A", "B"]);
  });
});

describe("sync freshness", () => {
  const now = 1_700_000_000_000;

  it("says what it means before the first sync", () => {
    expect(syncAgo(null, now)).toBe("Syncing…");
  });

  it("reads in seconds, then minutes, then hours", () => {
    expect(syncAgo(now - 2_000, now)).toBe("Last synced: just now");
    expect(syncAgo(now - 12_000, now)).toBe("Last synced: 12 seconds ago");
    expect(syncAgo(now - 3 * 60_000, now)).toBe("Last synced: 3 minutes ago");
    expect(syncAgo(now - 60_000, now)).toBe("Last synced: 1 minute ago");
    expect(syncAgo(now - 2 * 3_600_000, now)).toBe("Last synced: 2 hours ago");
  });

  it("never reports a negative age from a clock that ran backwards", () => {
    expect(syncAgo(now + 5_000, now)).toBe("Last synced: just now");
  });
});

/**
 * Unknown is not zero.
 *
 * A balance that could not be read used to drop its asset from the portfolio
 * entirely, which reads as "you no longer hold this" — the most alarming thing
 * a wallet can wrongly say, and reachable from nothing worse than an RPC
 * hiccup. Printing 0 instead would be a different lie.
 */
describe("portfolio — an unreadable balance", () => {
  it("keeps a token with an unknown balance visible even when hiding empties", () => {
    const rows = viewHoldings(
      [h({ symbol: "UNKNOWN", balance: null }), h({ symbol: "EMPTY", balance: 0 })],
      { hideZero: true },
    );
    expect(rows.map((r) => r.symbol)).toEqual(["UNKNOWN"]);
  });

  it("ranks an unknown balance below every known one", () => {
    const rows = viewHoldings(
      [h({ symbol: "UNKNOWN", balance: null, valueUsd: null }), h({ symbol: "EMPTY", balance: 0, valueUsd: null })],
      { sort: "balance" },
    );
    expect(rows.map((r) => r.symbol)).toEqual(["EMPTY", "UNKNOWN"]);
  });

  it("does not let an unknown balance masquerade as a value", () => {
    const rows = viewHoldings([
      h({ symbol: "REAL", balance: 1, valueUsd: 5 }),
      h({ symbol: "UNKNOWN", balance: null, valueUsd: null }),
    ]);
    expect(rows[0].symbol).toBe("REAL");
    expect(rows[1].valueUsd).toBeNull();
  });
});

/**
 * One slow token must not hold up the whole portfolio.
 *
 * Metadata comes from a chain read and the list waits on every row before
 * rendering any of them, so a single unresponsive contract left the user
 * staring at "Reading your balances…" with nothing on screen — indefinitely,
 * because nothing in the chain of promises had a deadline.
 */
describe("portfolio — token metadata is bounded", () => {
  const fallback = {
    symbol: "?", name: "Unknown token", decimals: 18, logoURI: null, verified: false,
  };

  it("uses the real metadata when it arrives in time", async () => {
    const meta = await resolveTokenMeta("0xabc", fallback, {
      timeoutMs: 500,
      fetcher: async () => ({ token: { symbol: "aUSDC", name: "Aave USDC", decimals: 6, logoURI: null, verified: true } }),
    });
    expect(meta.symbol).toBe("aUSDC");
    expect(meta.decimals).toBe(6);
  });

  it("gives up on a contract that never answers, rather than waiting forever", async () => {
    const started = Date.now();
    const meta = await resolveTokenMeta("0xslow", fallback, {
      timeoutMs: 60,
      fetcher: () => new Promise(() => {}), // never settles, like a dead contract
    });
    expect(meta).toEqual(fallback);
    expect(Date.now() - started, "must not have waited on the hung request").toBeLessThan(2000);
  });

  it("falls back when the lookup fails outright", async () => {
    const meta = await resolveTokenMeta("0xbad", fallback, {
      timeoutMs: 500,
      fetcher: async () => { throw new Error("network down"); },
    });
    expect(meta).toEqual(fallback);
  });

  it("falls back when the response carries no token", async () => {
    const meta = await resolveTokenMeta("0xempty", fallback, {
      timeoutMs: 500,
      fetcher: async () => ({ success: false }),
    });
    expect(meta).toEqual(fallback);
  });

  it("resolves each token independently, so one slow row cannot block the others", async () => {
    // The actual failure mode: the portfolio awaits all rows together, so a
    // list is only as fast as its worst token unless every lookup is bounded.
    const started = Date.now();
    const [fast, slow] = await Promise.all([
      resolveTokenMeta("0xfast", fallback, {
        timeoutMs: 60,
        fetcher: async () => ({ token: { ...fallback, symbol: "FAST" } }),
      }),
      resolveTokenMeta("0xslow", fallback, { timeoutMs: 60, fetcher: () => new Promise(() => {}) }),
    ]);
    expect(fast.symbol).toBe("FAST");
    expect(slow).toEqual(fallback);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/**
 * A newly-bought token not appearing in the portfolio traced back to
 * /api/portfolio/discover's single, unscoped, un-timed `eth_getLogs` scan: it
 * matches Transfer events from EVERY contract on the chain (not just one),
 * which is exactly the query shape production RPC either rejects outright or
 * accepts and then takes minutes to answer — the same failure class already
 * fixed once in nadfun.ts/wallet-intel.ts, but this call had no timeout and
 * no fallback, so it just silently reported "no tokens found".
 */
describe("discover — transfer-log window fallback", () => {
  it("uses the widest window's result when it answers", async () => {
    const calls: bigint[] = [];
    const logs = await fetchIncomingTransferLogs(
      1_000_000n,
      async (fromBlock) => { calls.push(fromBlock); return [{ address: "0xtoken" }]; },
      50,
    );
    expect(logs).toEqual([{ address: "0xtoken" }]);
    expect(calls).toHaveLength(1); // never fell back
  });

  it("falls back to a narrower window when the provider rejects the wide one outright", async () => {
    const windows: bigint[] = [];
    const logs = await fetchIncomingTransferLogs(
      1_000_000n,
      async (fromBlock) => {
        windows.push(fromBlock);
        if (windows.length === 1) throw new Error("query returned more than 10000 results");
        return [{ address: "0xfound" }];
      },
      50,
    );
    expect(logs).toEqual([{ address: "0xfound" }]);
    expect(windows.length).toBeGreaterThan(1); // the wide attempt was retried narrower
  });

  it("falls back when the provider accepts the range but never answers in time — a hang, not an error", async () => {
    const started = Date.now();
    const logs = await fetchIncomingTransferLogs(
      1_000_000n,
      async (fromBlock): Promise<{ address: string }[]> => {
        // The widest window hangs forever (mirrors the real "accepts the
        // range and takes minutes" failure); a narrower one answers.
        if (fromBlock === 1_000_000n - 200_000n) return new Promise(() => {});
        return [{ address: "0xslowchain" }];
      },
      50,
    );
    expect(logs).toEqual([{ address: "0xslowchain" }]);
    // Must not have waited out a real production-length timeout.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns an empty list, never throws, when every window fails", async () => {
    const logs = await fetchIncomingTransferLogs(
      1_000_000n,
      async () => { throw new Error("rate limited"); },
      50,
    );
    expect(logs).toEqual([]);
  });

  it("clamps the fromBlock at 0 for a chain younger than the window", async () => {
    let seenFrom: bigint | null = null;
    await fetchIncomingTransferLogs(
      1_000n, // latest block is younger than LOOKBACK_BLOCKS (200_000)
      async (fromBlock) => { seenFrom = fromBlock; return []; },
      50,
    );
    expect(seenFrom).toBe(0n);
  });
});

/**
 * Monad's real block interval (~0.4s) means a single LOOKBACK_BLOCKS-wide
 * window only ever covers ~22 hours of history — a token bought earlier in
 * the week was outside it entirely, with no error to explain why (a real
 * production report, not a hypothetical). GET now scans several windows,
 * anchored at progressively older blocks, in parallel — these tests confirm
 * a token that only shows up in an OLDER window still gets found.
 */
describe("GET /api/portfolio/discover — scans multiple history windows, not just the newest", () => {
  afterEach(() => {
    getBlockNumberImpl = async () => 0n;
    requestImpl = async () => [];
    resolveTokenImpl = async (address) => ({ address, symbol: "TKN", name: "Token", decimals: 18, verified: false });
  });

  function req(address: string): NextRequest {
    return new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${address}`);
  }

  it("finds a token whose only Transfer log falls in an OLDER window, beyond the first LOOKBACK_BLOCKS slice", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1"; // distinct per test — GET caches per-wallet for 5 min
    const OLD_TOKEN = "0x0000000000000000000000000000000000000ad1";
    getBlockNumberImpl = async () => 500_000n; // 3 windows: [300k,500k], [100k,300k], [0,100k]
    requestImpl = async ({ params }) => {
      const [{ fromBlock, toBlock }] = params;
      const from = BigInt(fromBlock);
      const to = BigInt(toBlock);
      // Only the oldest window (covering block 50,000) has this token's log.
      if (from <= 50_000n && to >= 50_000n) return [{ address: OLD_TOKEN }];
      return [];
    };
    resolveTokenImpl = async (address) => ({ address, symbol: "OLD", name: "Old Token", decimals: 18, verified: false });

    const { GET } = await import("@/app/api/portfolio/discover/route");
    const r = await GET(req(WALLET));
    const json = await r.json();
    expect(json.tokens).toEqual([{ address: OLD_TOKEN, decimals: 18 }]);
  });

  it("merges tokens found across DIFFERENT windows into one result, not just the last one checked", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
    const RECENT = "0x0000000000000000000000000000000000000a01";
    const MIDDLE = "0x0000000000000000000000000000000000000a02";
    const OLD = "0x0000000000000000000000000000000000000a03";
    getBlockNumberImpl = async () => 500_000n;
    requestImpl = async ({ params }) => {
      const [{ fromBlock, toBlock }] = params;
      const from = BigInt(fromBlock);
      const to = BigInt(toBlock);
      if (from === 300_000n && to === 500_000n) return [{ address: RECENT }];
      if (from === 100_000n && to === 300_000n) return [{ address: MIDDLE }];
      if (from === 0n && to === 100_000n) return [{ address: OLD }];
      return [];
    };

    const { GET } = await import("@/app/api/portfolio/discover/route");
    const r = await GET(req(WALLET));
    const json = await r.json();
    const addresses = (json.tokens as { address: string }[]).map((t) => t.address.toLowerCase()).sort();
    expect(addresses).toEqual([RECENT, MIDDLE, OLD].map((a) => a.toLowerCase()).sort());
  });

  it("a young chain (latest well under one window) still makes exactly one request, unchanged from before", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3";
    getBlockNumberImpl = async () => 1_000n;
    let callCount = 0;
    requestImpl = async () => { callCount += 1; return []; };
    const { GET } = await import("@/app/api/portfolio/discover/route");
    await GET(req(WALLET));
    expect(callCount).toBe(1);
  });
});

/**
 * The exact production report this fixes: a wallet holding several tokens
 * showed only MON and USDC in the Portfolio card. Traced to the metadata
 * resolution step run right after log discovery — resolveToken()'s
 * symbol()/name()/decimals() reads had no timeout of their own, unlike the
 * getLogs scan above (which was already hardened against a provider that
 * accepts a call and simply never answers it, rather than rejecting it).
 * ONE such contract among the discovered addresses hung the whole
 * Promise.all, the route ran past its own maxDuration, the client's fetch
 * failed, and usePortfolio's discovery silently degrades to "found nothing
 * extra" — leaving only the two base tokens, with no error surfaced anywhere.
 */
describe("GET /api/portfolio/discover — one stalled token's metadata must not hide every other one", () => {
  afterEach(() => {
    getBlockNumberImpl = async () => 0n;
    requestImpl = async () => [];
    resolveTokenImpl = async (address) => ({ address, symbol: "TKN", name: "Token", decimals: 18, verified: false });
  });

  function req(address: string): NextRequest {
    return new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${address}`);
  }

  it("skips a contract whose metadata read never answers, and still returns every other discovered token", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4";
    const FAST = "0x0000000000000000000000000000000000000b01";
    const STALLED = "0x0000000000000000000000000000000000000b02";
    getBlockNumberImpl = async () => 500_000n;
    requestImpl = async ({ params }) => {
      const [{ fromBlock, toBlock }] = params;
      if (BigInt(fromBlock) === 300_000n && BigInt(toBlock) === 500_000n) {
        return [{ address: FAST }, { address: STALLED }];
      }
      return [];
    };
    resolveTokenImpl = (address) => {
      if (address.toLowerCase() === STALLED) return new Promise(() => {}); // a dead/stalled contract -- never answers
      return Promise.resolve({ address, symbol: "FAST", name: "Fast Token", decimals: 18, verified: false });
    };

    const started = Date.now();
    const { GET } = await import("@/app/api/portfolio/discover/route");
    const r = await GET(req(WALLET));
    const json = await r.json();
    expect(json.tokens).toEqual([{ address: FAST, decimals: 18 }]);
    expect(Date.now() - started, "must not have waited out a real production-length timeout").toBeLessThan(8_000);
  }, 10_000);
});

/**
 * The other half of the real production report ("bought a memecoin, it's
 * not showing in my portfolio"): even once a token is genuinely discovered
 * (see the timeout fixes above), a wallet whose portfolio was viewed or
 * auto-synced any time in the preceding CACHE_MS kept serving that
 * now-stale token list for the rest of the window -- with no way to force
 * it, not even the manual Sync button, since every caller hit the same
 * unconditional cache check. `?fresh=1` is the one, narrow exception:
 * fired ONLY right after a trade completes (see warmPortfolioDiscovery and
 * useAskChat's syncDashboardAfter), never on the routine 20s auto-sync
 * heartbeat, which must keep respecting the cache exactly as before.
 */
describe("GET /api/portfolio/discover — ?fresh=1 bypasses the cache for one explicit re-scan", () => {
  afterEach(() => {
    getBlockNumberImpl = async () => 0n;
    requestImpl = async () => [];
    resolveTokenImpl = async (address) => ({ address, symbol: "TKN", name: "Token", decimals: 18, verified: false });
  });

  it("a normal (non-fresh) call still serves the cached result within the window", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5";
    const OLD = "0x0000000000000000000000000000000000000c01";
    const NEW = "0x0000000000000000000000000000000000000c02";
    getBlockNumberImpl = async () => 500_000n;
    let scanCount = 0;
    requestImpl = async ({ params }) => {
      const [{ fromBlock, toBlock }] = params;
      if (BigInt(fromBlock) === 300_000n && BigInt(toBlock) === 500_000n) {
        scanCount += 1;
        return scanCount === 1 ? [{ address: OLD }] : [{ address: OLD }, { address: NEW }];
      }
      return [];
    };
    resolveTokenImpl = async (address) => ({ address, symbol: "TKN", name: "Token", decimals: 18, verified: false });

    const { GET } = await import("@/app/api/portfolio/discover/route");
    const first = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`))).json();
    expect(first.tokens.map((t: { address: string }) => t.address)).toEqual([OLD]);

    // A plain re-fetch (what the routine auto-sync heartbeat does) must NOT
    // pick up the second token yet -- it should still be served the cache.
    const second = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`))).json();
    expect(second.cached).toBe(true);
    expect(second.tokens.map((t: { address: string }) => t.address)).toEqual([OLD]);
  });

  it("?fresh=1 forces a real re-scan and updates the cache for every subsequent (even non-fresh) reader", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6";
    const OLD = "0x0000000000000000000000000000000000000c03";
    const NEW = "0x0000000000000000000000000000000000000c04";
    getBlockNumberImpl = async () => 500_000n;
    let scanCount = 0;
    requestImpl = async ({ params }) => {
      const [{ fromBlock, toBlock }] = params;
      if (BigInt(fromBlock) === 300_000n && BigInt(toBlock) === 500_000n) {
        scanCount += 1;
        return scanCount === 1 ? [{ address: OLD }] : [{ address: OLD }, { address: NEW }];
      }
      return [];
    };
    resolveTokenImpl = async (address) => ({ address, symbol: "TKN", name: "Token", decimals: 18, verified: false });

    const { GET } = await import("@/app/api/portfolio/discover/route");
    const first = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`))).json();
    expect(first.tokens.map((t: { address: string }) => t.address)).toEqual([OLD]);

    // The freshly-bought token now shows up on the wallet's own explicit
    // post-trade check...
    const fresh = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}&fresh=1`))).json();
    expect(fresh.tokens.map((t: { address: string }) => t.address).sort()).toEqual([NEW, OLD].sort());

    // ...AND a plain, non-fresh re-fetch afterward (the routine heartbeat)
    // now also sees it, because warming the cache benefits every reader, not
    // just the one call that requested it.
    const afterWarm = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`))).json();
    expect(afterWarm.cached).toBe(true);
    expect(afterWarm.tokens.map((t: { address: string }) => t.address).sort()).toEqual([NEW, OLD].sort());
  });
});

/**
 * The reported production failure, reproduced at its root: a token bought
 * through PayAI minutes earlier was absent from the portfolio entirely.
 *
 * Discovery's only source was an address-less, 200k-block-wide eth_getLogs
 * fanned out across 8 windows at once — the single most rate-limit-prone
 * query in the product. When a provider throttles or refuses it, the route
 * cannot distinguish that from "this wallet holds nothing new" and returned
 * an empty list. PayAI already knew the answer without asking the chain: it
 * executed the trade and now records the received token's real contract
 * address at settlement (TxLogEntry.outputTokenAddress).
 */
describe("GET /api/portfolio/discover — a bought token survives a failing chain scan", () => {
  afterEach(() => {
    getBlockNumberImpl = async () => 0n;
    requestImpl = async () => [];
    resolveTokenImpl = async (address) => ({ address, symbol: "TKN", name: "Token", decimals: 18, verified: false });
    listTxImpl = async () => [];
    // The route's rate limiter is real and its in-memory bucket is on
    // globalThis, so without this every request in this file keys on the same
    // absent-IP subject and later cases 429 on the earlier ones' budget. Same
    // reset the other route suites use (see linked-wallets.test.ts).
    const g = globalThis as unknown as { __veripayRL?: Map<string, unknown> };
    g.__veripayRL?.clear();
  });

  const BOUGHT = "0x0000000000000000000000000000000000000d01";

  it("returns the just-bought token even when the log scan throws outright (a refused/throttled getLogs)", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7";
    getBlockNumberImpl = async () => { throw new Error("rate limited"); };
    listTxImpl = async () => [{ outputTokenAddress: BOUGHT }];

    const { GET } = await import("@/app/api/portfolio/discover/route");
    const json = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`))).json();
    expect(json.tokens.map((t: { address: string }) => t.address.toLowerCase())).toEqual([BOUGHT]);
    expect(json.degraded, "the caller should be able to tell this was the fallback half").toBe(true);
  });

  it("returns the just-bought token when the scan succeeds but finds nothing (logs outside the window)", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa8";
    getBlockNumberImpl = async () => 500_000n;
    requestImpl = async () => []; // scan works, just returns no transfers
    listTxImpl = async () => [{ outputTokenAddress: BOUGHT }];

    const { GET } = await import("@/app/api/portfolio/discover/route");
    const json = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`))).json();
    expect(json.tokens.map((t: { address: string }) => t.address.toLowerCase())).toEqual([BOUGHT]);
  });

  it("merges both sources without duplicating a token the scan ALSO found", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9";
    const AIRDROPPED = "0x0000000000000000000000000000000000000d02";
    getBlockNumberImpl = async () => 500_000n;
    requestImpl = async ({ params }) => {
      const [{ fromBlock, toBlock }] = params;
      if (BigInt(fromBlock) === 300_000n && BigInt(toBlock) === 500_000n) {
        return [{ address: BOUGHT }, { address: AIRDROPPED }]; // scan sees the bought one too
      }
      return [];
    };
    listTxImpl = async () => [{ outputTokenAddress: BOUGHT }];

    const { GET } = await import("@/app/api/portfolio/discover/route");
    const json = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`))).json();
    const addrs = json.tokens.map((t: { address: string }) => t.address.toLowerCase()).sort();
    expect(addrs).toEqual([BOUGHT, AIRDROPPED].sort());
  });

  it("ignores a non-address value in history — a bare symbol can never reach the balance reader", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab10";
    getBlockNumberImpl = async () => { throw new Error("rate limited"); };
    // "MONCAT" is what outputToken (the display symbol) holds; only a real
    // address belongs in outputTokenAddress.
    listTxImpl = async () => [{ outputTokenAddress: "MONCAT" }, { outputTokenAddress: null }];

    const { GET } = await import("@/app/api/portfolio/discover/route");
    const json = await (await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`))).json();
    expect(json.tokens).toEqual([]);
  });

  it("a wallet with no trade history and a failing scan still degrades quietly to empty, never an error", async () => {
    const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab11";
    getBlockNumberImpl = async () => { throw new Error("rate limited"); };
    const { GET } = await import("@/app/api/portfolio/discover/route");
    const r = await GET(new NextRequest(`https://usepayai.xyz/api/portfolio/discover?address=${WALLET}`));
    expect(r.status).toBe(200);
    expect((await r.json()).tokens).toEqual([]);
  });
});

describe("warmPortfolioDiscovery — the client-side trigger for the fresh re-scan above", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("requests a fresh (cache-bypassing) scan for the given wallet", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); return new Response("{}"); }));
    await warmPortfolioDiscovery("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("address=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(calls[0]).toContain("fresh=1");
    vi.unstubAllGlobals();
  });

  it("never throws even when the request fails outright -- the routine heartbeat still catches up later", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(warmPortfolioDiscovery("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
