import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Dashboard says one thing first: tell PayAI what you want done. Its
 * hierarchy is welcome → intent box → capabilities → needs attention →
 * recent activity → coming up → wallet. Balances support the page; they are
 * not its identity.
 *
 * Wallet figures come from usePortfolio — the hook PortfolioCard on the
 * Wallets page uses, which discovers holdings on-chain and prices them or
 * shows "—" — never a second pricing path.
 */

const src = readFileSync(new URL("../app/dashboard/page.tsx", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("Dashboard: intent first, wallet last", () => {
  it("leads with the welcome, one line on what it does, and the intent box", () => {
    expect(code).toMatch(/Welcome to PayAI/);
    // The landing page's slogan is said once, there — not repeated here.
    expect(code).not.toMatch(/onchain execution in seconds/);
    expect(code).toMatch(/Tell PayAI what you want done\. It understands your intent, prepares the action, and lets you review it before execution\./);
    expect(code).toMatch(/placeholder="What do you want to do\?"/);
  });

  it("orders the page: welcome → intent → attention → recent → coming up → wallet", () => {
    const order = ["Welcome to PayAI", "<AskEntry", 'title="Needs attention"', 'title="Recent activity"', 'title="Coming up"', 'title="Wallet"'].map((m) => code.indexOf(m));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("shows the Ask box alone — no shortcut chips, no example transactions", () => {
    // The Send/Trade/Automate/Schedule chips were removed on request (Oct 2026).
    expect(code).not.toMatch(/const CAPABILITIES|suggestions=\{/);
    const entry = /<AskEntry[\s\S]*?\/>/.exec(code)?.[0] ?? "";
    expect(entry).toMatch(/placeholder="What do you want to do\?"/);
    expect(entry).not.toMatch(/\d|USDC|MON|\.nad|0x/);
  });

  it("has no KPI tiles, count-up numbers, insights or charts", () => {
    expect(code).not.toMatch(/CountUp|SummaryTile|AI insights|strokeDasharray|Active automations/);
  });

  it("reads wallet figures through usePortfolio, and never prints an unknown balance as a number", () => {
    expect(code).toMatch(/usePortfolio\(wallet\.readAddress, wallet\.isLocked\)/);
    expect(code).toMatch(/formatUsd\(portfolio\.totalUsd\) \?\? "—"/);
  });
});
