import { describe, it, expect } from "vitest";
import { viewHoldings, resolveTokenMeta, type Holding } from "@/lib/hooks/usePortfolio";
import { syncAgo } from "@/lib/hooks/useSync";

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
