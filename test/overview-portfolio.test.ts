import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Overview dashboard needs to show the wallet's real total value across
 * every token it holds — a memecoin bought through Ask PayAI's trade flow, a
 * Nad.Fun launch, any swap output — not just a fixed pair.
 *
 * It reuses PortfolioCard/usePortfolio — the exact pair already proven on the
 * Wallets page, which discovers holdings from on-chain transfers (never a
 * maintained allowlist) and reports each token's real USD value or an honest
 * "—", never a fabricated number — rather than building a second, parallel
 * pricing/discovery path for Overview specifically.
 *
 * The KPI row above it used to be MON/USDC balance tiles. As of the Phase 2
 * dashboard reframe those became capability-neutral activity metrics
 * (On-chain activity / Payments / Automations / Success rate) so the page no
 * longer reads as payments-only; balances now live entirely in PortfolioCard,
 * their fuller home. This test guards the LAYOUT — a KPI row, then the
 * portfolio, then recent transactions — not the specific tiles.
 */

const src = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");

describe("Overview shows the wallet's real total value across every token it holds", () => {
  it("imports and renders the same PortfolioCard the Wallets page uses", () => {
    expect(src).toMatch(/import \{ PortfolioCard \} from "@\/components\/dashboard\/PortfolioCard"/);
    expect(src).toMatch(/<PortfolioCard address=\{wallet\.readAddress\} locked=\{wallet\.isLocked\}/);
  });

  it("is placed after the KPI tiles and before recent transactions, not instead of the KPI tiles", () => {
    // The KPI row is still there (now capability-neutral activity tiles), the
    // portfolio sits below it, and recent transactions below that — the
    // portfolio never replaces the KPI row.
    const kpiIdx = src.indexOf('label: "On-chain activity"');
    const portfolioIdx = src.indexOf("<PortfolioCard");
    const recentIdx = src.indexOf('title="Recent transactions"');
    expect(kpiIdx).toBeGreaterThan(-1);
    expect(portfolioIdx).toBeGreaterThan(kpiIdx);
    expect(recentIdx).toBeGreaterThan(portfolioIdx);
  });
});
