import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { WALLET_EVENT_TYPES, walletEventHref } from "../lib/wallet-service/types";

/**
 * Every wallet-event notification — the bell, the Activity Center, and the
 * deposit pop-up — used to send "View" to /dashboard/wallets regardless of
 * what actually happened. That page renders on-chain PaymentExecutor history,
 * a completely different data source, so it had never shown a swap, a
 * refund, an automation signature, or a deposit detected from outside PayAI.
 * Clicking "View" on any of those landed on a page with no trace of the
 * thing you clicked to see — which is what the user reported: "view" on a
 * transaction notification opened the wallet instead.
 *
 * walletEventHref is now the single source of truth for the destination, and
 * every surface that renders a wallet-event notification is required to use
 * it rather than hardcoding a page.
 */

describe("walletEventHref sends each event type where it actually renders", () => {
  it("sends a swap to the transaction log, where recordTx actually wrote it", () => {
    expect(walletEventHref("swap_completed")).toBe("/dashboard/transactions");
    expect(walletEventHref("swap_failed")).toBe("/dashboard/transactions");
  });

  it("sends an automation signature to the automation it authorized", () => {
    expect(walletEventHref("automation_signed")).toBe("/dashboard/automations");
    expect(walletEventHref("automation_executed")).toBe("/dashboard/automations");
  });

  it("sends a refund to the transaction log", () => {
    expect(walletEventHref("refund_completed")).toBe("/dashboard/transactions");
  });

  it("sends a deposit or withdrawal to the Activity Center, the only place that renders it", () => {
    // These are detected on-chain and exist ONLY in the wallet-events feed —
    // /dashboard/wallets never reads that feed at all.
    expect(walletEventHref("deposit_received")).toBe("/dashboard/activity");
    expect(walletEventHref("withdrawal_completed")).toBe("/dashboard/activity");
  });

  it("keeps genuinely wallet-identity events on /dashboard/wallets", () => {
    expect(walletEventHref("wallet_created")).toBe("/dashboard/wallets");
    expect(walletEventHref("wallet_connected")).toBe("/dashboard/wallets");
    expect(walletEventHref("wallet_disconnected")).toBe("/dashboard/wallets");
  });

  it("has an explicit answer for every event type the store can emit", () => {
    // Guards against a type being added to WALLET_EVENT_TYPES without anyone
    // deciding where its notification should go — silently falling back to
    // /dashboard/wallets is exactly the bug being fixed here.
    const handled = new Set([
      "swap_completed", "swap_failed", "automation_signed", "automation_executed",
      "refund_completed", "deposit_received", "withdrawal_completed",
      "wallet_created", "wallet_connected", "wallet_disconnected",
    ]);
    for (const t of WALLET_EVENT_TYPES) {
      expect(handled.has(t), `no explicit destination for "${t}"`).toBe(true);
    }
  });
});

describe("every surface that renders a wallet-event notification uses walletEventHref", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the bell (useNotifications) computes href from the event, not a literal string", () => {
    const src = read("../lib/hooks/useNotifications.ts");
    expect(src).toMatch(/href:\s*walletEventHref\(e\.type/);
    // The literal that caused the bug must not reappear on the wallet-events branch.
    expect(src).not.toMatch(/href:\s*"\/dashboard\/wallets"/);
  });

  it("the Activity Center (useActivity) computes href from the event too", () => {
    const src = read("../lib/hooks/useActivity.ts");
    expect(src).toMatch(/href:\s*walletEventHref\(e\.type/);
  });

  it("the deposit pop-up follows the notification's own href instead of a second hardcoded page", () => {
    const src = read("../components/dashboard/DepositAlert.tsx");
    expect(src).toMatch(/router\.push\(shown\.href\)/);
    expect(src).not.toMatch(/router\.push\("\/dashboard\/wallets"\)/);
  });
});
