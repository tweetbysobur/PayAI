"use client";

import { useState } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { shortAddress } from "@/lib/platform/username";
import { chooseFundingSource, showAccountReturn } from "@/components/dashboard/walletChoice";

const DISMISS_KEY = "payai_keep_external";

/**
 * The way back to the account.
 *
 * A PayAI Wallet's key lives only in memory, so a reload, a new tab or the
 * idle lock leaves it locked. With an external wallet connected, the app then
 * acts as that external wallet — its address, its history, its signatures —
 * which reads as "my account is gone". This says what is actually happening
 * and offers the one tap back: unlock the PayAI Wallet and pay from it again.
 * Keeping the external wallet is a choice too, remembered for this session.
 */
export function AccountReturnBanner() {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  const show = showAccountReturn(wallet, dismissed);
  if (!show) return null;

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      await chooseFundingSource(wallet, "embedded");
    } catch {
      setError(wallet.error ?? "Couldn't unlock your PayAI Wallet.");
    } finally {
      setBusy(false);
    }
  }

  function keepExternal() {
    wallet.switchWallet("external");
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
    setDismissed(true);
  }

  return (
    <div role="status" className="mb-4 rounded-lg border border-primary/30 bg-primary/[0.05] p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary-ink">
          <Fingerprint size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Your PayAI Wallet is locked</p>
          <p className="mt-0.5 text-pretty text-sm leading-relaxed text-muted-foreground">
            Payments are using <span className="whitespace-nowrap font-mono text-[13px] text-foreground">{shortAddress(wallet.externalAddress!)}</span> for now.
          </p>
          {error && <p role="alert" className="mt-1.5 text-sm text-danger">{error}</p>}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:ml-11 sm:flex sm:w-auto">
        <button type="button" onClick={unlock} disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:px-4">
          {busy && <Loader2 size={13} className="animate-spin" />} Unlock
        </button>
        <button type="button" onClick={keepExternal} disabled={busy}
          className="inline-flex h-10 items-center justify-center rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
          Keep this wallet
        </button>
      </div>
    </div>
  );
}
