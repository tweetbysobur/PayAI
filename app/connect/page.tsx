"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import { Wallet as WalletIcon, ShieldCheck, AlertTriangle, CheckCircle2, ExternalLink, Loader2, ArrowRight, Smartphone, QrCode } from "lucide-react";
import { walletConnectAvailable } from "@/lib/wallet/walletconnect";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { useWallet } from "@/lib/wallet/useWallet";
import { useDiscoveredWallets, type EIP6963ProviderDetail } from "@/lib/wallet/discovery";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { MONAD_CHAIN_NAME } from "@/lib/monad/public";

export default function ConnectPage() {
  const wallet = useWallet();
  const identity = useIdentity(wallet.address);
  const detected = useDiscoveredWallets();
  const [pending, setPending] = useState<string | null>(null); // rdns currently connecting
  const [switching, setSwitching] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const hasLegacy = typeof window !== "undefined" && !!window.ethereum;
  const wcAvailable = walletConnectAvailable();

  // Mobile detection + wallet-app deep links. A normal phone browser has no
  // injected wallet, so "install an extension" is a dead end there. Instead we
  // deep-link into a wallet app's built-in dapp browser, where window.ethereum
  // exists and connecting works. Computed after mount to avoid hydration drift.
  const [isMobile, setIsMobile] = useState(false);
  const [dappPath, setDappPath] = useState("usepayai.xyz/connect");
  useEffect(() => {
    setIsMobile(/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
    setDappPath(window.location.host + window.location.pathname);
  }, []);
  const metamaskLink = `https://metamask.app.link/dapp/${dappPath}`;
  const trustLink = `https://link.trustwallet.com/open_url?url=https://${dappPath}`;

  async function connectWith(detail: EIP6963ProviderDetail) {
    setLocalError(null);
    setPending(detail.info.rdns);
    try {
      await wallet.connect(detail.provider);
    } catch {
      setLocalError("Connection was cancelled or rejected in your wallet.");
    } finally {
      setPending(null);
    }
  }

  async function connectLegacy() {
    setLocalError(null);
    setPending("__legacy__");
    try {
      await wallet.connect();
    } catch {
      setLocalError("Connection was cancelled or rejected in your wallet.");
    } finally {
      setPending(null);
    }
  }

  async function connectWalletConnect() {
    setLocalError(null);
    setPending("__wc__");
    try {
      const { openWalletConnect } = await import("@/lib/wallet/walletconnect");
      const provider = await openWalletConnect();
      await wallet.connect(provider);
    } catch {
      setLocalError("WalletConnect connection was cancelled or failed. Please try again.");
    } finally {
      setPending(null);
    }
  }

  async function handleSwitch() {
    setLocalError(null);
    setSwitching(true);
    try {
      await wallet.switchNetwork();
    } catch {
      setLocalError(`Couldn't switch automatically. Please switch to ${MONAD_CHAIN_NAME} in your wallet.`);
    } finally {
      setSwitching(false);
    }
  }

  const connected = !!wallet.address;
  const wrongNetwork = connected && wallet.isWrongNetwork;

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={28} />
          <span className="text-sm font-semibold text-foreground">PayAI</span>
        </Link>
        <Link href="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Back to home</Link>
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

          <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">
            {connected ? "Wallet connected" : "Choose a wallet"}
          </h1>
          <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
            {connected
              ? `You're connected on ${MONAD_CHAIN_NAME}.`
              : `Connect a wallet on ${MONAD_CHAIN_NAME} to access your dashboard. PayAI is non-custodial, so you approve every payment yourself.`}
          </p>

          <div className="mt-7">
            <AnimatePresence mode="wait">
              {/* Connected */}
              {connected && !wrongNetwork && (
                <motion.div key="connected" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="space-y-3">
                  <div className="flex items-center justify-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-xs font-medium text-success">
                    <CheckCircle2 size={14} /> Connected on {MONAD_CHAIN_NAME}
                  </div>
                  <p className="text-center font-mono text-xs text-muted-foreground">{identity.display}</p>
                  <Link href="/dashboard" className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                    Continue to dashboard <ArrowRight size={15} />
                  </Link>
                  <button
                    onClick={() => wallet.disconnect()}
                    className="w-full rounded-lg border border-border px-4 py-2.5 text-xs text-muted-foreground transition hover:border-danger/40 hover:text-danger"
                  >
                    Disconnect and use a different wallet
                  </button>
                </motion.div>
              )}

              {/* Connected but wrong network */}
              {wrongNetwork && (
                <motion.div key="wrong-network" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-3">
                  <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                    <AlertTriangle size={14} className="shrink-0" /> Wrong network. Switch to {MONAD_CHAIN_NAME} to continue.
                  </div>
                  <button
                    onClick={handleSwitch}
                    disabled={switching}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                  >
                    {switching ? <Loader2 size={16} className="animate-spin" /> : <MonadMark size={16} />}
                    {switching ? "Switching…" : `Switch to ${MONAD_CHAIN_NAME}`}
                  </button>
                  <button
                    onClick={() => wallet.disconnect()}
                    className="w-full rounded-lg border border-border px-4 py-2.5 text-xs text-muted-foreground transition hover:border-danger/40 hover:text-danger"
                  >
                    Disconnect
                  </button>
                </motion.div>
              )}

              {/* Not connected — wallet picker */}
              {!connected && (
                <motion.div key="picker" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-2.5">
                  {detected.length > 0 ? (
                    detected.map((d) => (
                      <button
                        key={d.info.rdns}
                        onClick={() => connectWith(d)}
                        disabled={pending !== null}
                        className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm text-foreground transition hover:border-primary/50 hover:bg-input/40 disabled:opacity-60"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={d.info.icon} alt="" width={24} height={24} className="h-6 w-6 rounded-md" />
                        <span className="flex-1 text-left font-medium">{d.info.name}</span>
                        {pending === d.info.rdns
                          ? <Loader2 size={16} className="animate-spin text-primary" />
                          : <ArrowRight size={15} className="text-muted-foreground" />}
                      </button>
                    ))
                  ) : hasLegacy ? (
                    <button
                      onClick={connectLegacy}
                      disabled={pending !== null}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                    >
                      {pending === "__legacy__" ? <Loader2 size={16} className="animate-spin" /> : <WalletIcon size={16} />}
                      {pending === "__legacy__" ? "Connecting…" : "Connect wallet"}
                    </button>
                  ) : isMobile ? (
                    <div className="space-y-3">
                      <div className="flex items-start gap-2 rounded-lg border border-border bg-input/40 px-3 py-2.5 text-xs text-muted-foreground">
                        <Smartphone size={14} className="mt-0.5 shrink-0 text-primary" />
                        <span>To connect on your phone, open PayAI inside your wallet app&apos;s browser.</span>
                      </div>
                      <a href={metamaskLink} className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                        <WalletIcon size={16} /> Open in MetaMask
                      </a>
                      <a href={trustLink} className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                        Open in Trust Wallet <ArrowRight size={14} className="text-muted-foreground" />
                      </a>
                      <p className="pt-1 text-center text-xs text-muted-foreground">
                        Already in a wallet browser?{" "}
                        <button onClick={connectLegacy} className="text-primary underline underline-offset-2">Tap to connect</button>.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                        <AlertTriangle size={14} className="shrink-0" /> No wallet detected in this browser.
                      </div>
                      <a href="https://metamask.io/download" target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                        Install MetaMask <ExternalLink size={14} className="text-muted-foreground" />
                      </a>
                      <a href="https://rabby.io" target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                        Install Rabby <ExternalLink size={14} className="text-muted-foreground" />
                      </a>
                    </div>
                  )}

                  {/* WalletConnect — works everywhere: QR on desktop, one-tap
                      deep link to any wallet on mobile (no "open in app" hop). */}
                  {wcAvailable && (
                    <>
                      <div className="flex items-center gap-3 py-0.5">
                        <div className="h-px flex-1 bg-border" />
                        <span className="text-[11px] text-muted-foreground">or</span>
                        <div className="h-px flex-1 bg-border" />
                      </div>
                      <button
                        onClick={connectWalletConnect}
                        disabled={pending !== null}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground transition hover:border-primary/50 hover:bg-input/40 disabled:opacity-60"
                      >
                        {pending === "__wc__" ? <Loader2 size={16} className="animate-spin text-primary" /> : <QrCode size={16} className="text-primary" />}
                        {pending === "__wc__" ? "Connecting…" : "WalletConnect"}
                      </button>
                    </>
                  )}

                  {detected.length > 0 && (
                    <p className="pt-1 text-center text-xs text-muted-foreground">You&apos;ll approve the connection in the wallet you choose.</p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {(localError || wallet.error) && (
              <p className="mt-3 text-center text-xs text-danger">{localError || wallet.error}</p>
            )}
          </div>

          <div className="mt-7 border-t border-border pt-5 text-center text-xs text-muted-foreground">
            <p className="flex items-center justify-center gap-1.5"><ShieldCheck size={12} /> Your keys never leave your wallet. PayAI never asks for your seed phrase.</p>
            <Link href="/security" className="mt-1.5 inline-block text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">How PayAI keeps you safe →</Link>
          </div>
        </motion.div>
      </div>
    </main>
  );
}
