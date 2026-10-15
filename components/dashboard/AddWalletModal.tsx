"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, Loader2, QrCode, Wallet, X } from "lucide-react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useDiscoveredWallets, type EIP6963ProviderDetail } from "@/lib/wallet/discovery";
import { walletConnectAvailable } from "@/lib/wallet/walletconnect";
import { FundingSourcePicker } from "@/components/dashboard/FundingSourcePicker";
import { shortAddress } from "@/lib/platform/username";
import { afterExternalConnect } from "@/components/dashboard/walletChoice";

/**
 * Add an external wallet to a PayAI account — without leaving the account.
 *
 * This used to be a link to /connect, the first-time onboarding page. That
 * full page load ended the passkey session (its key lives only in memory),
 * /connect then reloaded into the dashboard, and with the PayAI Wallet locked
 * the app fell back to acting as the external wallet — signing PayAI's access
 * grant for it and showing its data. The user had connected a second wallet
 * and found themselves in what looked like a different account.
 *
 * Here the wallet connects in place: no navigation, so the passkey session
 * survives, and the account stays the wallet that acts. Then the person
 * chooses — explicitly — which wallet pays, and can link the new wallet to
 * the account (two approvals: the wallet, then the passkey).
 */
export function AddWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useWallet();
  const discovered = useDiscoveredWallets();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "choose">("pick");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function connect(id: string, getProvider: () => Promise<EIP6963ProviderDetail["provider"] | undefined>) {
    setError(null);
    setPending(id);
    try {
      const provider = await getProvider();
      await wallet.connectExternal(provider);
      // The account stays the wallet that acts until the person chooses
      // otherwise on the next step — connecting is not choosing.
      afterExternalConnect(wallet);
      setStep("choose");
    } catch {
      setError("The connection was cancelled or rejected in your wallet.");
    } finally {
      setPending(null);
    }
  }

  const wcAvailable = walletConnectAvailable();
  const hasInjected = typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-contrast/60 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="add-wallet-title">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-xl border border-border bg-panel p-5 sm:max-w-md sm:rounded-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="add-wallet-title" className="text-base font-semibold text-foreground">
              {step === "pick" ? "Add a wallet" : "Wallet connected"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {step === "pick"
                ? "Connect an external wallet alongside your PayAI Wallet. You stay in your account."
                : "Choose which wallet pays. You can change this any time from the wallet menu."}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-muted-foreground hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X size={16} />
          </button>
        </div>

        {step === "pick" ? (
          <div className="space-y-2">
            {wallet.externalAddress && (
              <p className="rounded-lg border border-border px-3.5 py-3 text-sm text-muted-foreground">
                {shortAddress(wallet.externalAddress)} is already connected.{" "}
                <button type="button" onClick={() => setStep("choose")} className="font-medium text-primary-ink hover:underline">Choose how to use it</button>
              </p>
            )}
            {discovered.map((d) => (
              <button
                key={d.info.rdns}
                type="button"
                onClick={() => connect(d.info.rdns, async () => d.provider)}
                disabled={pending !== null}
                className="flex w-full items-center gap-3 rounded-lg border border-border px-3.5 py-3 text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-input/40 disabled:opacity-60"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={d.info.icon} alt="" width={22} height={22} className="h-[22px] w-[22px] rounded-md" />
                <span className="flex-1 text-left font-medium">{d.info.name}</span>
                {pending === d.info.rdns ? <Loader2 size={15} className="animate-spin text-primary-ink" /> : <ArrowRight size={14} className="text-muted-foreground" />}
              </button>
            ))}
            {discovered.length === 0 && hasInjected && (
              <button
                type="button"
                onClick={() => connect("__injected__", async () => undefined)}
                disabled={pending !== null}
                className="flex w-full items-center gap-3 rounded-lg border border-border px-3.5 py-3 text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-input/40 disabled:opacity-60"
              >
                <Wallet size={18} className="text-primary-ink" />
                <span className="flex-1 text-left font-medium">Browser wallet</span>
                {pending === "__injected__" ? <Loader2 size={15} className="animate-spin text-primary-ink" /> : <ArrowRight size={14} className="text-muted-foreground" />}
              </button>
            )}
            {wcAvailable && (
              <button
                type="button"
                onClick={() => connect("__wc__", async () => (await import("@/lib/wallet/walletconnect")).openWalletConnect())}
                disabled={pending !== null}
                className="flex w-full items-center gap-3 rounded-lg border border-border px-3.5 py-3 text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-input/40 disabled:opacity-60"
              >
                <QrCode size={18} className="text-primary-ink" />
                <span className="flex-1 text-left font-medium">WalletConnect</span>
                {pending === "__wc__" ? <Loader2 size={15} className="animate-spin text-primary-ink" /> : <ArrowRight size={14} className="text-muted-foreground" />}
              </button>
            )}
            {discovered.length === 0 && !hasInjected && !wcAvailable && (
              <p className="rounded-lg border border-dashed border-border px-3.5 py-4 text-center text-sm text-muted-foreground">
                No wallet found in this browser. Install a wallet extension, or open PayAI in your wallet app&apos;s browser.
              </p>
            )}
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <p className="pt-1 text-xs text-muted-foreground">You&apos;ll approve the connection in the wallet you choose. Connecting moves no funds.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <FundingSourcePicker />
            <button type="button" onClick={onClose} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Check size={14} aria-hidden /> Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
