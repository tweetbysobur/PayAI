import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { afterExternalConnect, chooseFundingSource, showAccountReturn, type WalletChoicePort } from "@/components/dashboard/walletChoice";

/**
 * A PayAI account (passkey wallet) plus an external wallet.
 *
 * Reported: connecting an external wallet "doesn't direct back to the user
 * account". Root cause: "Connect a wallet" on the Wallets page was a link to
 * /connect (first-time onboarding). That full page load ended the passkey
 * session — its key lives only in memory — and /connect then reloaded into
 * the dashboard. With the PayAI Wallet locked, the wallet service falls back
 * to the external wallet as the acting wallet (and signs PayAI's access grant
 * for it), so the person landed in what looked like a different account, with
 * no visible way back and no choice about which wallet pays.
 *
 * Fixed without touching the wallet service itself:
 *   - connecting from inside the account happens IN PLACE (AddWalletModal) —
 *     no navigation, so the passkey session survives and the account stays
 *     the acting wallet;
 *   - the person then chooses where funds come from (FundingSourcePicker,
 *     also on the Wallets page) and can link the wallet to the account;
 *   - when the account is locked and the external wallet is acting, a banner
 *     says so and offers the one tap back (AccountReturnBanner);
 *   - /connect, on a device with an account, returns to the account's
 *     Wallets page instead of a dashboard that acts as the external wallet.
 */

function fake(over: Partial<WalletChoicePort> = {}) {
  const calls: string[] = [];
  const w: WalletChoicePort = {
    accountAddress: "0xacc0000000000000000000000000000000000001",
    externalAddress: "0xe0e0000000000000000000000000000000000002",
    isLocked: false,
    activeKind: "embedded",
    switchWallet: vi.fn((k) => { calls.push(`switch:${k}`); }),
    setUpEmbeddedWallet: vi.fn(async () => { calls.push("unlock"); }),
    ...over,
  };
  return { w, calls };
}

describe("after connecting an external wallet in place", () => {
  it("an unlocked account stays the wallet that acts", () => {
    const { w, calls } = fake();
    afterExternalConnect(w);
    expect(calls).toEqual(["switch:embedded"]);
  });
  it("a locked account isn't forced (it can't act until unlocked) — the next step asks", () => {
    const { w, calls } = fake({ isLocked: true });
    afterExternalConnect(w);
    expect(calls).toEqual([]);
  });
  it("without an account there is nothing to return to", () => {
    const { w, calls } = fake({ accountAddress: null });
    afterExternalConnect(w);
    expect(calls).toEqual([]);
  });
});

describe("choosing where funds come from", () => {
  it("choosing the locked PayAI Wallet unlocks it FIRST, then makes it the payer", async () => {
    const { w, calls } = fake({ isLocked: true, activeKind: "external" });
    await chooseFundingSource(w, "embedded");
    expect(calls).toEqual(["unlock", "switch:embedded"]);
  });
  it("if the unlock fails nothing changes — the external wallet keeps paying", async () => {
    const { w, calls } = fake({ isLocked: true, activeKind: "external", setUpEmbeddedWallet: vi.fn(async () => { throw new Error("cancelled"); }) });
    await expect(chooseFundingSource(w, "embedded")).rejects.toThrow("cancelled");
    expect(calls).toEqual([]);
  });
  it("choosing the external wallet needs no passkey", async () => {
    const { w, calls } = fake();
    await chooseFundingSource(w, "external");
    expect(calls).toEqual(["switch:external"]);
  });
});

describe("the way back to the account", () => {
  it("shows exactly when the account is locked and the external wallet is acting", () => {
    expect(showAccountReturn(fake({ isLocked: true, activeKind: "external" }).w, false)).toBe(true);
    expect(showAccountReturn(fake({ isLocked: false, activeKind: "external" }).w, false)).toBe(false); // a deliberate choice
    expect(showAccountReturn(fake({ isLocked: true, activeKind: "embedded" }).w, false)).toBe(false);
    expect(showAccountReturn(fake({ isLocked: true, activeKind: "external", accountAddress: null }).w, false)).toBe(false);
    expect(showAccountReturn(fake({ isLocked: true, activeKind: "external" }).w, true)).toBe(false); // "keep using this wallet"
  });
});

describe("no in-account control navigates away to /connect any more", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  for (const f of ["components/dashboard/LinkedWalletsCard.tsx", "components/dashboard/WalletManager.tsx"]) {
    it(`${f} opens the in-place dialog`, () => {
      const src = read(f);
      expect(src).not.toMatch(/href="\/connect"/);
      expect(src).toMatch(/<AddWalletModal /);
    });
  }
  it("the dialog connects without navigating, and never signs or sends", () => {
    const src = read("components/dashboard/AddWalletModal.tsx");
    expect(src).toMatch(/wallet\.connectExternal\(provider\)/);
    expect(src).toMatch(/afterExternalConnect\(wallet\)/);
    expect(src).not.toMatch(/location\.href|router\.push|sendTransaction|signMessage/);
  });
  it("the top-bar menu offers 'Add another wallet' to an account, in place", () => {
    const src = read("components/dashboard/Topbar.tsx");
    expect(src).toMatch(/Add another wallet/);
    expect(src).toMatch(/<AddWalletModal open=\{addWalletOpen\}/);
  });
  it("the dashboard shows the way back; the Wallets page shows the funding choice", () => {
    expect(read("app/dashboard/layout.tsx")).toMatch(/<AccountReturnBanner \/>/);
    expect(read("app/dashboard/wallets/page.tsx")).toMatch(/<FundingSourcePicker \/>/);
  });
  it("/connect on a device with an account returns to the account's Wallets page", () => {
    const src = read("app/connect/page.tsx");
    expect(src).toMatch(/const next = accountAddress \? "\/dashboard\/wallets" : "\/dashboard"/);
    expect(src).toMatch(/Back to my account/);
  });
  it("the protected wallet service is unchanged by this fix (it already supports both wallets)", () => {
    const src = read("lib/wallet-service/WalletServiceContext.tsx");
    expect(src).toMatch(/canSwitchWallets: !!accountAddress && externalUsable/);
  });
});
