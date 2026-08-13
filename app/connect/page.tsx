"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  Wallet as WalletIcon, ShieldCheck, AlertTriangle, CheckCircle2, ExternalLink, Loader2,
  ArrowRight, Smartphone, QrCode, ChevronDown, Lock, FileCheck2,
} from "lucide-react";
import { walletConnectAvailable } from "@/lib/wallet/walletconnect";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { useWallet } from "@/lib/wallet/useWallet";
import { useDiscoveredWallets, type EIP6963ProviderDetail } from "@/lib/wallet/discovery";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { MONAD_CHAIN_NAME } from "@/lib/monad/public";

const CONSENT_KEY = "payai_tos_accepted_v1";

/** Curated catalog — shown even when a wallet isn't installed (an install
 *  link), matched by name against whatever EIP-6963 actually detects so an
 *  installed wallet connects directly instead of just linking out. */
const RECOMMENDED = [
  { name: "Backpack", match: /backpack/i, url: "https://backpack.app" },
  { name: "MetaMask", match: /metamask/i, url: "https://metamask.io/download" },
  { name: "Rabby", match: /rabby/i, url: "https://rabby.io" },
];
const MORE_WALLETS = [
  { name: "Binance Wallet", match: /binance/i, url: "https://www.binance.com/en/web3wallet" },
  { name: "OKX Wallet", match: /okx|okex/i, url: "https://www.okx.com/web3" },
  { name: "Coinbase Wallet", match: /coinbase/i, url: "https://www.coinbase.com/wallet" },
];

type Step = "consent" | "wallets" | "status";

export default function ConnectPage() {
  const wallet = useWallet();
  const identity = useIdentity(wallet.address);
  const detected = useDiscoveredWallets();
  const [pending, setPending] = useState<string | null>(null); // rdns or sentinel currently connecting
  const [switching, setSwitching] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showAllWallets, setShowAllWallets] = useState(false);

  const [agreed, setAgreed] = useState(false);
  const [step, setStep] = useState<Step>("consent");
  useEffect(() => {
    // Returning users who already accepted don't need to see the consent
    // screen again every time — but Terms/Privacy stay one click away always.
    if (typeof window !== "undefined" && localStorage.getItem(CONSENT_KEY) === "1") {
      setAgreed(true);
      setStep(wallet.address ? "status" : "wallets");
    } else if (wallet.address) {
      setStep("status");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The mount effect above runs before WalletProvider's own silent-reconnect
  // effect (an ancestor) has resolved eth_accounts, so a returning,
  // already-consented user's wallet.address is still null at that point and
  // the page lands on "wallets" instead of the "status" fast path. Once the
  // silent reconnect resolves asynchronously, catch up and advance — but
  // only from "wallets" with consent already on record, so this never
  // fires mid explicit-connect (those already setStep("status") themselves)
  // or reopens "status" after an explicit disconnect.
  useEffect(() => {
    if (wallet.address && step === "wallets" && localStorage.getItem(CONSENT_KEY) === "1") {
      setStep("status");
    }
  }, [wallet.address, step]);

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

  function acceptAndContinue() {
    if (!agreed) return;
    localStorage.setItem(CONSENT_KEY, "1");
    setStep("wallets");
  }

  async function connectWith(detail: EIP6963ProviderDetail) {
    setLocalError(null);
    setPending(detail.info.rdns);
    try {
      await wallet.connect(detail.provider);
      setStep("status");
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
      setStep("status");
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
      setStep("status");
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

  // Match curated names against whatever's actually detected via EIP-6963, so
  // a real install connects directly instead of only offering a download link.
  const findDetected = (re: RegExp) => detected.find((d) => re.test(d.info.name));
  const extraDetected = useMemo(
    () => detected.filter((d) => ![...RECOMMENDED, ...MORE_WALLETS].some((w) => w.match.test(d.info.name))),
    [detected],
  );

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
        <h1 className="sr-only">Connect your wallet to PayAI</h1>
        <motion.div
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
          className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
        >
          <AnimatePresence mode="wait">
            {/* Step 1 — consent gate. Must accept before any wallet can be picked. */}
            {step === "consent" && (
              <motion.div key="consent" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.25 }} className="p-8">
                <div className="mb-6 flex items-center justify-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink">
                    <ShieldCheck size={26} />
                  </div>
                </div>
                <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">Before you connect</h2>
                <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
                  Quick security note, then choose your wallet.
                </p>

                <div className="mt-6 space-y-2.5 rounded-xl border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-4">
                  <div className="flex items-start gap-2.5 text-xs text-foreground">
                    <Lock size={14} className="mt-0.5 shrink-0 text-primary-ink" />
                    <span>PayAI never asks for your private key or seed phrase, and never can.</span>
                  </div>
                  <div className="flex items-start gap-2.5 text-xs text-foreground">
                    <ShieldCheck size={14} className="mt-0.5 shrink-0 text-primary-ink" />
                    <span>Every transaction requires your approval in your wallet. Nothing moves without it.</span>
                  </div>
                </div>

                <label className="mt-5 flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border bg-input text-primary-ink accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span>
                    I agree to PayAI&apos;s{" "}
                    <Link href="/terms" target="_blank" className="text-primary-ink hover:underline">Terms of Service</Link>
                    {" "}and{" "}
                    <Link href="/privacy" target="_blank" className="text-primary-ink hover:underline">Privacy Policy</Link>.
                  </span>
                </label>

                <button
                  onClick={acceptAndContinue}
                  disabled={!agreed}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continue <ArrowRight size={15} />
                </button>
              </motion.div>
            )}

            {/* Step 2 — wallet picker, organized into sections. */}
            {step === "wallets" && (
              <motion.div key="wallets" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.25 }} className="p-8">
                <div className="mb-6 flex items-center justify-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink">
                    <WalletIcon size={26} />
                  </div>
                </div>
                <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">Choose a wallet</h2>
                <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
                  Connect on {MONAD_CHAIN_NAME}. You approve every payment yourself.
                </p>

                <div className="mt-6 space-y-5">
                  {hasLegacy && detected.length === 0 && (
                    <button
                      onClick={connectLegacy}
                      disabled={pending !== null}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                    >
                      {pending === "__legacy__" ? <Loader2 size={16} className="animate-spin" /> : <WalletIcon size={16} />}
                      {pending === "__legacy__" ? "Connecting…" : "Connect wallet"}
                    </button>
                  )}

                  {!hasLegacy && isMobile && detected.length === 0 && (
                    <div className="space-y-3">
                      <div className="flex items-start gap-2 rounded-lg border border-border bg-input/40 px-3 py-2.5 text-xs text-muted-foreground">
                        <Smartphone size={14} className="mt-0.5 shrink-0 text-primary-ink" />
                        <span>To connect on your phone, open PayAI inside your wallet app&apos;s browser.</span>
                      </div>
                      <a href={metamaskLink} className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                        <WalletIcon size={16} /> Open in MetaMask
                      </a>
                      <a href={trustLink} className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm text-foreground transition hover:border-primary/40">
                        Open in Trust Wallet <ArrowRight size={14} className="text-muted-foreground" />
                      </a>
                    </div>
                  )}

                  <WalletSection
                    title="Recommended"
                    items={RECOMMENDED}
                    findDetected={findDetected}
                    pending={pending}
                    onConnect={connectWith}
                  />
                  <WalletSection
                    title="More wallets"
                    items={MORE_WALLETS}
                    findDetected={findDetected}
                    pending={pending}
                    onConnect={connectWith}
                  />

                  {(extraDetected.length > 0) && (
                    <div>
                      <button
                        onClick={() => setShowAllWallets((v) => !v)}
                        className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      >
                        View all wallets
                        <ChevronDown size={14} className={`transition-transform duration-200 ${showAllWallets ? "rotate-180" : ""}`} />
                      </button>
                      <AnimatePresence initial={false}>
                        {showAllWallets && (
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                            <div className="mt-2 space-y-2">
                              {extraDetected.map((d) => (
                                <button
                                  key={d.info.rdns}
                                  onClick={() => connectWith(d)}
                                  disabled={pending !== null}
                                  className="group flex w-full items-center gap-3 rounded-lg border border-border px-3.5 py-3 text-sm text-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40 disabled:opacity-60"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={d.info.icon} alt="" width={22} height={22} className="h-[22px] w-[22px] rounded-md" />
                                  <span className="flex-1 text-left font-medium">{d.info.name}</span>
                                  {pending === d.info.rdns
                                    ? <Loader2 size={15} className="animate-spin text-primary-ink" />
                                    : <ArrowRight size={14} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
                                </button>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

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
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/50 hover:bg-input/40 disabled:opacity-60"
                      >
                        {pending === "__wc__" ? <Loader2 size={16} className="animate-spin text-primary-ink" /> : <QrCode size={16} className="text-primary-ink" />}
                        {pending === "__wc__" ? "Connecting…" : "WalletConnect"}
                      </button>
                    </>
                  )}

                  {localError && <p className="text-center text-xs text-danger">{localError}</p>}
                  <p className="pt-1 text-center text-xs text-muted-foreground">You&apos;ll approve the connection in the wallet you choose.</p>
                </div>
              </motion.div>
            )}

            {/* Step 3 — status: wrong network, or a real confirmation before the dashboard. */}
            {step === "status" && (
              <motion.div key="status" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="p-8">
                {wrongNetwork ? (
                  <>
                    <div className="mb-6 flex items-center justify-center">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-warning/12 text-warning">
                        <AlertTriangle size={26} />
                      </div>
                    </div>
                    <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">Wrong network</h2>
                    <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
                      Your wallet is connected, but not on {MONAD_CHAIN_NAME}. Switch to continue.
                    </p>
                    <div className="mt-7 space-y-3">
                      <button
                        onClick={handleSwitch}
                        disabled={switching}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                      >
                        {switching ? <Loader2 size={16} className="animate-spin" /> : <MonadMark size={16} />}
                        {switching ? "Switching…" : `Switch to ${MONAD_CHAIN_NAME}`}
                      </button>
                      <button
                        onClick={() => { wallet.disconnect(); setStep("wallets"); }}
                        className="w-full rounded-lg border border-border px-4 py-2.5 text-xs text-muted-foreground transition hover:border-danger/40 hover:text-danger"
                      >
                        Disconnect
                      </button>
                      {localError && <p className="text-center text-xs text-danger">{localError}</p>}
                    </div>
                  </>
                ) : (
                  <ConnectedConfirmation
                    display={identity.display}
                    onDisconnect={() => { wallet.disconnect(); setStep("wallets"); }}
                  />
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="border-t border-border px-8 py-5 text-center text-xs text-muted-foreground">
            <p className="flex items-center justify-center gap-1.5"><ShieldCheck size={12} /> Your keys never leave your wallet.</p>
            <Link href="/security" className="mt-1.5 inline-flex items-center gap-1 text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
              How PayAI keeps you safe <ArrowRight size={11} />
            </Link>
          </div>
        </motion.div>
      </div>
    </main>
  );
}

/** A curated wallet row — connects directly if EIP-6963 finds a live match,
 *  otherwise links out to install it. Never shows a wrong or fabricated logo:
 *  installed wallets get their real injected icon, others get a neutral
 *  monogram badge. */
function WalletRow({ name, url, live, pending, onConnect }: {
  name: string; url: string; live?: EIP6963ProviderDetail; pending: string | null; onConnect: (d: EIP6963ProviderDetail) => void;
}) {
  const busy = live && pending === live.info.rdns;
  const content = (
    <>
      {live ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={live.info.icon} alt="" width={28} height={28} className="h-7 w-7 rounded-lg" />
      ) : (
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-input text-xs font-semibold text-muted-foreground">{name.charAt(0)}</span>
      )}
      <span className="flex-1 text-left text-sm font-medium text-foreground">{name}</span>
      {live ? (
        busy ? <Loader2 size={15} className="animate-spin text-primary-ink" /> : <ArrowRight size={14} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      ) : (
        <span className="text-[11px] font-medium text-muted-foreground">Install</span>
      )}
    </>
  );
  const cls = "group flex w-full items-center gap-3 rounded-xl border border-border px-3.5 py-3 transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40 disabled:opacity-60";
  return live
    ? <button onClick={() => onConnect(live)} disabled={pending !== null} className={cls}>{content}</button>
    : <a href={url} target="_blank" rel="noreferrer" className={cls}>{content}</a>;
}

function WalletSection({ title, items, findDetected, pending, onConnect }: {
  title: string;
  items: { name: string; match: RegExp; url: string }[];
  findDetected: (re: RegExp) => EIP6963ProviderDetail | undefined;
  pending: string | null;
  onConnect: (d: EIP6963ProviderDetail) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="space-y-2">
        {items.map((w) => (
          <WalletRow key={w.name} name={w.name} url={w.url} live={findDetected(w.match)} pending={pending} onConnect={onConnect} />
        ))}
      </div>
    </div>
  );
}

/** Real confirmation screen before the dashboard — not an instant redirect.
 *  Auto-advances after a short beat, but a manual button works immediately
 *  for anyone who doesn't want to wait. */
function ConnectedConfirmation({ display, onDisconnect }: { display: string; onDisconnect: () => void }) {
  useEffect(() => {
    const t = setTimeout(() => { window.location.href = "/dashboard"; }, 2200);
    return () => clearTimeout(t);
  }, []);
  return (
    <>
      <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }} className="mb-6 flex items-center justify-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success/12 text-success">
          <CheckCircle2 size={28} />
        </div>
      </motion.div>
      <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">Wallet connected</h2>
      <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">You&apos;re all set on {MONAD_CHAIN_NAME}.</p>

      <div className="mt-6 flex items-center justify-center gap-2 rounded-xl border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-4 py-3">
        <MonadMark size={14} />
        <span className="font-mono text-sm text-foreground">{display}</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-medium text-success"><FileCheck2 size={11} /> Verified</span>
      </div>

      <div className="mt-7 space-y-3">
        <Link href="/dashboard" className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
          Continue to dashboard <ArrowRight size={15} />
        </Link>
        <button onClick={onDisconnect} className="w-full rounded-lg border border-border px-4 py-2.5 text-xs text-muted-foreground transition hover:border-danger/40 hover:text-danger">
          Disconnect and use a different wallet
        </button>
      </div>
    </>
  );
}
