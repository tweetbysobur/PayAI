import { describe, it, expect } from "vitest";
import { filterActivity, PERIOD_MS, type ActivityItem } from "@/lib/hooks/useActivity";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function a(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: `id-${Math.random()}`,
    kind: "payment",
    at: NOW,
    title: "Payment",
    detail: "Sent 5 USDC",
    status: "ok",
    ...over,
  };
}

describe("activity filters", () => {
  it("keeps only what falls inside the chosen period", () => {
    const items = [
      a({ id: "now", at: NOW - 1_000 }),
      a({ id: "yesterday", at: NOW - 2 * DAY }),
      a({ id: "lastmonth", at: NOW - 20 * DAY }),
    ];
    expect(filterActivity(items, { period: "today", now: NOW }).map((i) => i.id)).toEqual(["now"]);
    expect(filterActivity(items, { period: "week", now: NOW }).map((i) => i.id)).toEqual(["now", "yesterday"]);
    expect(filterActivity(items, { period: "month", now: NOW }).map((i) => i.id)).toHaveLength(3);
  });

  it("returns everything for the all-time period", () => {
    const items = [a({ at: NOW - 5 * 365 * DAY })];
    expect(filterActivity(items, { period: "all", now: NOW })).toHaveLength(1);
    expect(PERIOD_MS.all).toBe(Number.POSITIVE_INFINITY);
  });

  it("filters by kind, and treats several kinds as 'any of these'", () => {
    const items = [
      a({ id: "p", kind: "payment" }),
      a({ id: "s", kind: "swap" }),
      a({ id: "w", kind: "wallet" }),
    ];
    expect(filterActivity(items, { kinds: ["swap"], now: NOW }).map((i) => i.id)).toEqual(["s"]);
    expect(filterActivity(items, { kinds: ["swap", "wallet"], now: NOW }).map((i) => i.id)).toEqual(["s", "w"]);
  });

  it("treats no kind selected as no kind filter, not as 'nothing matches'", () => {
    // An empty filter set is the default state of the page. Reading it as an
    // exclusion would show a user an empty feed the moment they cleared their
    // filters.
    const items = [a({ id: "p" }), a({ id: "s", kind: "swap" })];
    expect(filterActivity(items, { kinds: [], now: NOW })).toHaveLength(2);
  });

  it("searches the title, the detail, the token and the hash", () => {
    const items = [
      a({ id: "usdc", detail: "Sent 5 USDC to alice.nad", token: "USDC" }),
      a({ id: "swap", title: "Swap", detail: "Swap 1 MON → 2 aUSDC", token: "aUSDC" }),
      a({ id: "hash", detail: "Something", txHash: "0xdeadbeef" }),
    ];
    expect(filterActivity(items, { query: "alice", now: NOW }).map((i) => i.id)).toEqual(["usdc"]);
    expect(filterActivity(items, { query: "swap", now: NOW }).map((i) => i.id)).toEqual(["swap"]);
    expect(filterActivity(items, { query: "0xdead", now: NOW }).map((i) => i.id)).toEqual(["hash"]);
  });

  it("applies period, kind and query together", () => {
    const items = [
      a({ id: "keep", kind: "swap", at: NOW - DAY, detail: "Swap 1 MON to USDC" }),
      a({ id: "wrongkind", kind: "payment", at: NOW - DAY, detail: "Swap-like payment" }),
      a({ id: "toolate", kind: "swap", at: NOW - 20 * DAY, detail: "Swap 1 MON to USDC" }),
    ];
    const rows = filterActivity(items, { period: "week", kinds: ["swap"], query: "mon", now: NOW });
    expect(rows.map((i) => i.id)).toEqual(["keep"]);
  });

  it("does not mutate the list it was given", () => {
    const items = [a({ id: "a" }), a({ id: "b" })];
    filterActivity(items, { period: "today", now: NOW });
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});
