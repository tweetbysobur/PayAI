"use client";

import { useState } from "react";
import { Check, Fingerprint, KeyRound, Link2, Loader2, Lock } from "lucide-react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { shortAddress } from "@/lib/platform/username";
import { chooseFundingSource } from "@/components/dashboard/walletChoice";
import type { WalletProviderKind } from "@/lib/wallet-service/types";

/**
 * Where funds come from: the PayAI Wallet (passkey) or a connected external
 * wallet — shown side by side with their real balances, and chosen
 * explicitly. The choice is the wallet service's own (switchWallet), the
 * same one the wallet menu's "Paying as" sets: it decides which wallet signs
 * the next payment, plan or swap. Nothing is signed or moved by choosing.
 *
 * Choosing a locked PayAI Wallet unlocks it first (one passkey check);
 * otherwise the tap would silently leave the external wallet acting.
 */
export function FundingSourcePicker({ compact = false }: { compact?: boolean }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState<WalletProviderKind | "link" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = wallet.accountAddress;
  const external = wallet.externalAddress;
  const accountBal = useWalletBalances(account, false);
  const externalBal = useWalletBalances(external, false);

  if (!account && !external) return null;
  const linked = external ? wallet.linkedWallets.find((w) => w.address.toLowerCase() === external.toLowerCase()) : undefined;

  async function choose(kind: WalletProviderKind) {
    setError(null);
    setBusy(kind);
    try {
      await chooseFundingSource(wallet, kind);
    } catch {
      setError(wallet.error ?? "Couldn't unlock your PayAI Wallet.");
    } finally {
      setBusy(null);
    }
  }

  async function link() {
    setError(null);
    setBusy("link");
    try {
      if (wallet.isLocked) await wallet.setUpEmbeddedWallet({ create: false });
      await wallet.linkExternalWallet();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link that wallet.");
    } finally {
      setBusy(null);
    }
  }

  const rows: { kind: WalletProviderKind; title: string; address: string; icon: typeof Fingerprint; bal: typeof accountBal; note: string }[] = [];
  if (account) rows.push({ kind: "embedded", title: "PayAI Wallet", address: account, icon: Fingerprint, bal: accountBal, note: wallet.isLocked ? "Locked — choosing it unlocks it with your passkey" : "Your account's wallet (passkey)" });
  if (external) rows.push({ kind: "external", title: linked?.label || "Connected wallet", address: external, icon: KeyRound, bal: externalBal, note: linked ? "Linked to your account" : "Connected, not linked to your account" });

  return (
    <div>
      {!compact && <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Pay from</p>}
      <div role="radiogroup" aria-label="Pay from" className="space-y-2">
        {rows.map((r) => {
          const active = wallet.activeKind === r.kind;
          const Icon = r.icon;
          const locked = r.kind === "embedded" && wallet.isLocked;
          return (
            <button
              key={r.kind}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => { void choose(r.kind); }}
              disabled={busy != null}
              className={`flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${
                active ? "border-primary/60 bg-primary/[0.06]" : "border-border hover:border-primary/30"
              }`}
            >
              <Icon size={16} className={active ? "shrink-0 text-primary-ink" : "shrink-0 text-muted-foreground"} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  {r.title}
                  {locked && <Lock size={11} className="text-muted-foreground" aria-label="Locked" />}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">{shortAddress(r.address)}</span>
                <span className="block text-[11px] text-muted-foreground">{r.note}</span>
              </span>
              <span className="shrink-0 text-right text-xs tabular-nums text-foreground">
                <span className="block">{r.bal.usdc ?? "—"} USDC</span>
                <span className="block text-muted-foreground">{r.bal.mon ?? "—"} MON</span>
              </span>
              <span className="w-4 shrink-0">
                {busy === r.kind ? <Loader2 size={14} className="animate-spin text-muted-foreground" /> : active ? <Check size={14} className="text-primary-ink" aria-hidden /> : null}
              </span>
            </button>
          );
        })}
      </div>

      {external && account && !linked && (
        <div className="mt-3 rounded-lg border border-border px-3.5 py-3">
          <p className="text-sm text-foreground">Link {shortAddress(external)} to your account?</p>
          <p className="mt-1 text-pretty text-xs leading-relaxed text-muted-foreground">
            Keeps it listed under your account. You&apos;ll approve twice — in that wallet, then with your passkey. Neither
            wallet can spend from the other.
          </p>
          <button type="button" onClick={link} disabled={busy != null}
            className="mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
            {busy === "link" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} Link to my account
          </button>
        </div>
      )}
      {!compact && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Payments, swaps and plans you approve are signed by the wallet chosen here. Automations keep the wallet they were set up with.
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
