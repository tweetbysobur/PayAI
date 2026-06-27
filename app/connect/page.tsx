"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Wallet as WalletIcon, ShieldCheck, AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { useWallet } from "@/lib/wallet/useWallet";
import { MONAD_CHAIN_NAME } from "@/lib/monad/public";

type Provider = "metamask" | "rabby" | "injected" | "none";

function detectProvider(): Provider {
  if (typeof window === "undefined" || !window.ethereum) return "none";
  const eth = window.ethereum as unknown as { isMetaMask?: boolean; isRabby?: boolean };
  if (eth.isRabby) return "rabby";
  if (eth.isMetaMask) return "metamask";
  return "injected";
}

const PROVIDER_LABEL: Record<Provider, string> = {
  metamask: "MetaMask", rabby: "Rabby", injected: "your wallet", none: "No wallet detected",
};

export default function ConnectPage() {
  const wallet = useWallet();
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>("none");
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => { setProvider(detectProvider()); }, []);

  const status = useMemo<"no-wallet" | "disconnected" | "wrong-network" | "connected">(() => {
    if (provider === "none") return "no-wallet";
    if (!wallet.address) return "disconnected";
    if (wallet.isWrongNetwork) return "wrong-network";
    return "connected";
  }, [provider, wallet.address, wallet.isWrongNetwork]);

  useEffect(() => {
    if (status === "connected") {
      const t = setTimeout(() => router.push("/dashboard"), 900);
      return () => clearTimeout(t);
    }
  }, [status, router]);

  async function handleConnect() {
    setLocalError(null); setConnecting(true);
    try { await wallet.connect(); } catch { setLocalError("Connection was cancelled or rejected."); }
    finally { setConnecting(false); }
  }

  async function handleSwitch() {
    setLocalError(null); setSwitching(true);
    try { await wallet.switchNetwork(); } catch { setLocalError("Could not switch network. Switch to " + MONAD_CHAIN_NAME + " manually in your wallet."); }
    finally { setSwitching(false); }
  }

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={28} />
          <span className="text-sm font-semibold text-foreground">PayAI</span>
        </Link>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">Back to home</Link>
      </header>

      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
          className="w-full max-w-md rounded-2xl border border-border bg-panel p-8 shadow-2xl"
        >
          <div className="mb-6 flex items-center justify-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary">
              <WalletIcon size={26} />
            </div>
          </div>

          <h1 className="text-center text-xl font-semibold text-foreground">Connect your wallet</h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            PayAI runs entirely on-chain. Connect a wallet on {MONAD_CHAIN_NAME} to access your dashboard.
          </p>

          <div className="mt-7">
            <AnimatePresence mode="wait">
              {status === "no-wallet" && (
                <motion.div key="no-wallet" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
                  <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                    <AlertTriangle size={14} className="shrink-0" /> No compatible wallet found in this browser.
                  </div>
                  <a href="https://metamask.io/download" target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                    Install MetaMask <ExternalLink size={14} className="text-muted-foreground" />
                  </a>
                  <a href="https://rabby.io" target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                    Install Rabby <ExternalLink size={14} className="text-muted-foreground" />
                  </a>
                  <p className="pt-1 text-center text-xs text-muted-foreground">Any EIP-1193 compatible wallet extension will work.</p>
                </motion.div>
              )}

              {status === "disconnected" && (
                <motion.div key="disconnected" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
                  <button
                    onClick={handleConnect}
                    disabled={connecting}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                  >
                    {connecting ? <Loader2 size={16} className="animate-spin" /> : <WalletIcon size={16} />}
                    {connecting ? "Connecting…" : `Connect ${PROVIDER_LABEL[provider]}`}
                  </button>
                  <p className="text-center text-xs text-muted-foreground">You&apos;ll be asked to approve the connection in your wallet.</p>
                </motion.div>
              )}

              {status === "wrong-network" && (
                <motion.div key="wrong-network" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
                  <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                    <AlertTriangle size={14} className="shrink-0" /> Wrong network — switch to {MONAD_CHAIN_NAME} to continue.
                  </div>
                  <button
                    onClick={handleSwitch}
                    disabled={switching}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                  >
                    {switching ? <Loader2 size={16} className="animate-spin" /> : <MonadMark size={16} />}
                    {switching ? "Switching…" : `Switch to ${MONAD_CHAIN_NAME}`}
                  </button>
                </motion.div>
              )}

              {status === "connected" && (
                <motion.div key="connected" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="space-y-3 text-center">
                  <div className="flex items-center justify-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-xs text-success">
                    <CheckCircle2 size={14} /> Connected on {MONAD_CHAIN_NAME}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">{wallet.address?.slice(0, 10)}…{wallet.address?.slice(-6)}</p>
                  <Link href="/dashboard" className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                    Continue to dashboard
                  </Link>
                </motion.div>
              )}
            </AnimatePresence>

            {(localError || wallet.error) && (
              <p className="mt-3 text-center text-xs text-danger">{localError || wallet.error}</p>
            )}
          </div>

          <div className="mt-7 flex items-center justify-center gap-1.5 border-t border-border pt-5 text-xs text-muted-foreground">
            <ShieldCheck size={12} /> Your keys never leave your wallet. PayAI never requests your seed phrase.
          </div>
        </motion.div>
      </div>
    </main>
  );
}
