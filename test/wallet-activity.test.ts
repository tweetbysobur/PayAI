import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { summarizeWalletActivity } from "@/lib/platform/walletActivity";
import type { TxLogEntry } from "@/lib/platform/types";

/**
 * Wallets page "Wallet Intelligence": activity comes from the wallet's own
 * PayAI log (every feature), not only the legacy PaymentExecutor contract —
 * which is why payments made through Ask showed "no activity".
 */
const NOW = Date.UTC(2026, 9, 12, 18);
const DAY = 86_400_000;
let n = 0;
const tx = (p: Partial<TxLogEntry>): TxLogEntry => ({
  id: `t${++n}`, at: NOW - DAY, decision: "executed", action: "payment", amount: 1, token: "USDC",
  recipient: "0x1", riskScore: 5, compliance: "approved", summary: "x", ...p,
});

describe("summarizeWalletActivity", () => {
  it("counts every executed PayAI transaction, by kind, and never blends tokens", () => {
    const s = summarizeWalletActivity([
      tx({ feature: "payment", amount: 5, token: "USDC" }),
      tx({ feature: "payment", amount: 2, token: "mon" }),
      tx({ feature: "automation", amount: 1, token: "USDC" }),
      tx({ feature: "swap", amount: 10, token: "MON" }),
      tx({ feature: "trade", amount: 3, token: "USDC" }),
      tx({ feature: "protocol", amount: null }),
      tx({ feature: "payment", decision: "blocked", amount: 99 }),
      tx({ feature: "payment", amount: 50, at: NOW - 40 * DAY }),
    ], NOW);
    expect(s.transactions).toBe(7);
    expect(s.payments).toBe(4);
    expect(s.swaps).toBe(2);
    expect(s.sent30dByToken).toEqual({ USDC: 6, MON: 2 }); // swaps and the 40-day-old payment excluded
    expect(s.lastAt).toBe(NOW - DAY);
  });
  it("infers the kind for rows recorded before `feature` existed", () => {
    const s = summarizeWalletActivity([tx({ feature: undefined, action: "swap" }), tx({ feature: undefined, action: "payment" })], NOW);
    expect([s.payments, s.swaps]).toEqual([1, 1]);
  });
  it("charts the last 14 days that had activity, oldest first", () => {
    const rows = Array.from({ length: 20 }, (_, i) => tx({ at: NOW - i * DAY }));
    const s = summarizeWalletActivity(rows, NOW);
    expect(s.daily).toHaveLength(14);
    expect(s.daily[0].date < s.daily[13].date).toBe(true);
  });
  it("an empty wallet is all zeros, not invented numbers", () => {
    expect(summarizeWalletActivity([], NOW)).toEqual({ transactions: 0, payments: 0, swaps: 0, sent30dByToken: {}, daily: [], lastAt: null });
  });
});

describe("Wallets page", () => {
  const page = readFileSync("app/dashboard/wallets/page.tsx", "utf8");
  it("has no AI Insights and no executor-only or hard-coded figures", () => {
    expect(page).not.toMatch(/AI Insights|intel\.insights|Gas spent|Payments received|Lifetime volume|Largest transaction|Average transaction|\.nads domain/);
  });
  it("reads activity from the wallet's own PayAI history", () => {
    expect(page).toMatch(/fetchHistory\(wallet\.address\)/);
    expect(page).toMatch(/activity\.summary\.payments/);
  });
  it("the history response carries totals over all rows", () => {
    expect(readFileSync("app/api/agent/route.ts", "utf8")).toMatch(/summary: summarizeWalletActivity\(rows\)/);
  });
});
