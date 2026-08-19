import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Overview dashboard's KPI row only ever knew about two assets — MON and
 * USDC balance tiles — because that's what the page was written around. A
 * wallet holding anything else (a memecoin bought through Ask PayAI's trade
 * flow, a Nad.Fun launch, any swap output) had no representation anywhere on
 * the page: no total, no per-token value, nothing.
 *
 * The fix reuses PortfolioCard/usePortfolio — the exact pair already proven
 * on the Wallets page, which discovers holdings from on-chain transfers
 * (never a maintained allowlist) and reports each token's real USD value or
 * an honest "—", never a fabricated number — rather than building a second,
 * parallel pricing/discovery path for Overview specifically.
 */

const src = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");

describe("Overview shows the wallet's real total value across every token it holds", () => {
  it("imports and renders the same PortfolioCard the Wallets page uses", () => {
    expect(src).toMatch(/import \{ PortfolioCard \} from "@\/components\/dashboard\/PortfolioCard"/);
    expect(src).toMatch(/<PortfolioCard address=\{wallet\.readAddress\} locked=\{wallet\.isLocked\}/);
  });

  it("is placed after the KPI tiles and before recent transactions, not instead of the KPI tiles", () => {
    // The MON/USDC/volume/lifetime tiles stay -- they're still meaningful,
    // just no longer the only picture of what the wallet holds.
    const kpiIdx = src.indexOf('label: "MON balance"');
    const portfolioIdx = src.indexOf("<PortfolioCard");
    const recentIdx = src.indexOf('title="Recent transactions"');
    expect(kpiIdx).toBeGreaterThan(-1);
    expect(portfolioIdx).toBeGreaterThan(kpiIdx);
    expect(recentIdx).toBeGreaterThan(portfolioIdx);
  });
});
