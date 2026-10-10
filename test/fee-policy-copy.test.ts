import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fee copy must say what the code charges.
 *
 * The audit found the help page, the fee docs and the Terms saying "swaps have
 * no platform fee" while the code does charge one on the main swap route:
 *   - payai/swap@1.0.0 (the plan path Ask uses for "swap 10 MON to USDC") is
 *     executor-only and adds PayAITradeExecutor's on-chain feeBps on top
 *     (lib/sdk/actions/swap; test/sdk-swap.test.ts pins the quote's
 *     "PayAI fee … (0.25%, on top)" line and the confirmed fee event);
 *   - trades route through the executor when one is selected for the venue
 *     (lib/monad/tradeQuote.ts; test/trade-quote.test.ts pins the fee line);
 *   - contracts/LIVE_CONTRACTS.md records feeBps = 25 on both executors, read
 *     via feeBps(), with canary transactions showing the 0.25% to the treasury.
 * Routes the executor can't take (direct Nad.Fun, multi-hop, the direct swap
 * card, the flag-off path) pay no PayAI fee and show no fee line.
 *
 * No fee behaviour changed — only the copy that described it.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const PAGES = {
  "docs/fees": read("../app/docs/fees/page.tsx"),
  help: read("../app/dashboard/help/page.tsx"),
  terms: read("../app/terms/page.tsx"),
  landing: read("../app/page.tsx"),
};

describe("no public page says swaps are always fee-free", () => {
  for (const [name, src] of Object.entries(PAGES)) {
    it(name, () => {
      expect(src).not.toMatch(/Swaps (?:have|currently have) no (?:platform )?fee/i);
      expect(src).not.toMatch(/0% on swaps/i);
      expect(src).not.toMatch(/\["Swaps", "None"\]/);
    });
  }
});

describe("each page that lists fees says which swaps pay one", () => {
  for (const name of ["docs/fees", "help", "terms"] as const) {
    it(`${name}: executor-routed swaps pay 0.25% on top; direct routes pay none`, () => {
      const src = PAGES[name];
      expect(src).toMatch(/trade\s+executor/);
      expect(src).toMatch(/0\.25%/);
      expect(src).toMatch(/directly\s+to\s+a\s+DEX/);
    });
  }

  it("the fee docs say where the swap rate comes from (the contract, shown in the quote)", () => {
    expect(PAGES["docs/fees"]).toMatch(/feeBps\(\)/);
    expect(PAGES["docs/fees"]).toMatch(/PayAI fee/);
  });

  it("the landing FAQ's wording stays true either way", () => {
    expect(PAGES.landing).toMatch(/0\.25% fee on supported fee-bearing transactions/);
  });
});

describe("the code still charges what the copy says (no behaviour changed here)", () => {
  it("the swap action is executor-only and discloses the fee on top", () => {
    const swap = read("../lib/sdk/actions/swap/index.ts");
    expect(swap).toMatch(/EXECUTOR_ONLY/);
    expect(swap).toMatch(/getExecutorFeeBps/);
    expect(swap).toMatch(/"PayAI fee"/);
  });

  it("the live executors record feeBps 25", () => {
    const live = read("../contracts/LIVE_CONTRACTS.md");
    expect(live.match(/\| feeBps \| `25` \(0\.25%\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
