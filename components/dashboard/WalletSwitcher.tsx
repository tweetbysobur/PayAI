"use client";

import { useState } from "react";
import { Check, Fingerprint, KeyRound, Loader2, Lock } from "lucide-react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { shortAddress } from "@/lib/platform/username";
import type { WalletProviderKind } from "@/lib/wallet-service/types";

/**
 * Move between the PayAI Wallet and a connected external wallet.
 *
 * Connecting MetaMask alongside a PayAI Wallet used to replace it outright:
 * the account was still there, but the only route back was to disconnect. So
 * both are listed here, always in the same order with the account first,
 * because the account is the thing you return to and a list that reorders
 * itself is a list you have to read every time.
 *
 * One tap switches. Nothing is signed, nothing is disconnected — the choice
 * only decides which wallet acts next.
 */
export function WalletSwitcher({ onSwitched }: { onSwitched?: () => void }) {
  const wallet = useWallet();
  const [unlocking, setUnlocking] = useState(false);
  if (!wallet.canSwitchWallets) return null;

  /**
   * The account can be locked while an external wallet is the one acting —
   * a reload ends the in-memory key but leaves MetaMask connected. Choosing
   * it then has to unlock first, or the tap would silently do nothing.
   */
  async function choose(kind: WalletProviderKind) {
    if (kind === "embedded" && wallet.isLocked) {
      setUnlocking(true);
      try {
        await wallet.setUpEmbeddedWallet({ create: false });
      } catch {
        return; // the error surfaces through wallet.error; keep the menu open
      } finally {
        setUnlocking(false);
      }
    }
    wallet.switchWallet(kind);
    onSwitched?.();
  }

  const rows: { kind: WalletProviderKind; label: string; address: string; icon: typeof Fingerprint }[] = [];
  if (wallet.accountAddress) {
    rows.push({ kind: "embedded", label: "PayAI Wallet", address: wallet.accountAddress, icon: Fingerprint });
  }
  if (wallet.externalAddress) {
    const linked = wallet.linkedWallets.find(
      (w) => w.address.toLowerCase() === wallet.externalAddress?.toLowerCase(),
    );
    rows.push({
      kind: "external",
      label: linked?.label || "External wallet",
      address: wallet.externalAddress,
      icon: KeyRound,
    });
  }

  return (
    <div className="border-b border-border py-1">
      <p className="px-4 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Paying as
      </p>
      {rows.map((row) => {
        const active = wallet.activeKind === row.kind;
        const Icon = row.icon;
        const locked = row.kind === "embedded" && wallet.isLocked;
        return (
          <button
            key={row.kind}
            onClick={() => { void choose(row.kind); }}
            disabled={unlocking}
            aria-current={active}
            className={`flex w-full items-center gap-2.5 px-4 py-2 text-left transition hover:bg-input/50 ${
              active ? "bg-primary/[0.06]" : ""
            }`}
          >
            <Icon size={13} className={active ? "text-primary-ink" : "text-muted-foreground"} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">{row.label}</span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {locked ? "Locked — tap to unlock" : shortAddress(row.address)}
              </span>
            </span>
            {unlocking && locked ? (
              <Loader2 size={13} className="shrink-0 animate-spin text-muted-foreground" />
            ) : locked ? (
              <Lock size={12} className="shrink-0 text-muted-foreground" />
            ) : active ? (
              <Check size={13} className="shrink-0 text-primary-ink" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
