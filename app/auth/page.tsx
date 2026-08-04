"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  ShieldCheck, ArrowRight, Loader2, Mail, CheckCircle2, ChevronLeft,
  Fingerprint, AlertTriangle,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { BrandIcon } from "@/components/BrandIcons";

const CONSENT_KEY = "payai_tos_accepted_v1";

type Step = "consent" | "choose" | "email-code" | "wallet" | "done";

function AuthFlow() {
  const wallet = useWalletService();
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState<Step>("consent");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Returning from an OAuth redirect (?step=wallet) drops the user straight
  // at the passkey step — their account exists, the wallet is one prompt away.
  useEffect(() => {
    const err = params.get("error");
    if (err) setError(err === "invalid_state" ? "That sign-in link expired. Please try again." : err === "apple_not_configured" ? "Continue with Apple isn't set up on this deployment yet." : err);
    if (params.get("step") === "wallet") { setAgreed(true); setStep("wallet"); return; }
    if (typeof window !== "undefined" && localStorage.getItem(CONSENT_KEY) === "1") {
      setAgreed(true);
      setStep("choose");
    }
  }, [params]);

  useEffect(() => {
    if (step === "done") {
      const t = setTimeout(() => router.push("/dashboard"), 1400);
      return () => clearTimeout(t);
    }
  }, [step, router]);

  function acceptAndContinue() {
    if (!agreed) return;
    localStorage.setItem(CONSENT_KEY, "1");
    setStep("choose");
  }

  async function sendCode() {
    setError(null);
    setPending("email");
    try {
      await wallet.requestEmailCode(email);
      setStep("email-code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the code.");
    } finally {
      setPending(null);
    }
  }

  async function verifyCode() {
    setError(null);
    try {
      await wallet.verifyEmailCode(email, code);
      setStep("wallet");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code.");
    }
  }

  /** The one passkey ceremony that creates or recovers the wallet. */
  async function finishWallet() {
    setError(null);
    try {
      await wallet.setUpEmbeddedWallet();
      setStep("done");
    } catch {
      setError(wallet.error ?? "Couldn't set up your wallet. Please try again.");
    }
  }

  const social: { method: "google" | "apple" | "x"; label: string; available: boolean }[] = [
    { method: "google", label: "Continue with Google", available: wallet.authMethods.google },
    { method: "apple", label: "Continue with Apple", available: wallet.authMethods.apple },
    { method: "x", label: "Continue with X", available: wallet.authMethods.x },
  ];
  const anySocial = social.some((s) => s.available) || wallet.authMethods.email;

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={28} />
          <span className="text-sm font-semibold text-foreground">PayAI</span>
        </Link>
        <Link href="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Back to home</Link>
      </header>

      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <motion.div
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
          className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
        >
          <AnimatePresence mode="wait">
            {/* ── Consent gate ─────────────────────────────────────────── */}
            {step === "consent" && (
              <motion.div key="consent" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22 }} className="p-8">
                <div className="mb-6 flex items-center justify-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"><ShieldCheck size={26} /></div>
                </div>
                <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">Welcome to PayAI</h1>
                <p className="mx-auto mt-2 max-w-xs text-center text-sm leading-relaxed text-muted-foreground">
                  Payments on Monad, in plain English. No browser extension needed.
                </p>

                <div className="mt-6 space-y-2.5 rounded-xl border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-4">
                  <div className="flex items-start gap-2.5 text-xs text-foreground">
                    <Fingerprint size={14} className="mt-0.5 shrink-0 text-primary-ink" />
                    <span>Your wallet is secured by your device&apos;s passkey — no seed phrase to write down, ever.</span>
                  </div>
                  <div className="flex items-start gap-2.5 text-xs text-foreground">
                    <ShieldCheck size={14} className="mt-0.5 shrink-0 text-primary-ink" />
                    <span>PayAI never sees your private key, and never asks for a seed phrase.</span>
                  </div>
                </div>

                <label className="mt-5 flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
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
                  onClick={acceptAndContinue} disabled={!agreed}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Continue <ArrowRight size={15} />
                </button>
              </motion.div>
            )}

            {/* ── Choose how to continue ───────────────────────────────── */}
            {step === "choose" && (
              <motion.div key="choose" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22 }} className="p-8">
                <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">Choose how you&apos;d like to continue</h1>
                <p className="mt-2 text-center text-sm text-muted-foreground">Your wallet is created automatically. It takes seconds.</p>

                <div className="mt-6 space-y-2.5">
                  {/* Fastest path: no redirect, no inbox — just the device. */}
                  {wallet.embeddedSupported && (
                    <button
                      onClick={() => setStep("wallet")}
                      className="flex w-full items-center gap-3 rounded-lg border-2 border-primary/50 bg-gradient-to-b from-primary/[0.08] to-transparent px-4 py-3.5 text-sm font-semibold text-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary"
                    >
                      <Fingerprint size={17} className="text-primary-ink" />
                      <span className="flex-1 text-left">Continue with PayAI Wallet</span>
                      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary-ink">Fastest</span>
                    </button>
                  )}

                  {social.map((s) => (
                    <button
                      key={s.method}
                      onClick={() => (s.available ? wallet.connectEmbeddedOAuth(s.method) : setError(`${s.label} isn't set up on this deployment yet.`))}
                      className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40"
                    >
                      <BrandIcon name={s.method} size={16} />
                      <span className="flex-1 text-left">{s.label}</span>
                      {!s.available && <span className="text-[10px] font-medium text-muted-foreground">Not set up</span>}
                    </button>
                  ))}

                  <div className="flex items-center gap-2 rounded-lg border border-border bg-input/40 px-3 py-2.5">
                    <Mail size={14} className="text-muted-foreground" />
                    <input
                      type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                  <button
                    onClick={() => (wallet.authMethods.email ? sendCode() : setError("Continue with Email isn't set up on this deployment yet."))}
                    disabled={!email.includes("@") || pending === "email"}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-input/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pending === "email" ? <Loader2 size={15} className="animate-spin" /> : <>Continue with Email <ArrowRight size={14} /></>}
                  </button>

                  {!anySocial && !wallet.embeddedSupported && (
                    <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                      No sign-in method is available on this device yet. You can still connect an existing wallet below.
                    </p>
                  )}

                  <div className="flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[11px] text-muted-foreground">Already have a wallet?</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  <Link
                    href="/connect"
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-3 text-sm font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                  >
                    Connect Existing Wallet
                  </Link>

                  {error && <p className="text-center text-xs text-danger">{error}</p>}
                </div>
              </motion.div>
            )}

            {/* ── Email code ───────────────────────────────────────────── */}
            {step === "email-code" && (
              <motion.div key="code" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22 }} className="p-8">
                <button onClick={() => setStep("choose")} className="mb-4 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronLeft size={13} /> Back
                </button>
                <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">Check your email</h1>
                <p className="mt-2 text-center text-sm text-muted-foreground">We sent a 6-digit code to {email}.</p>
                <input
                  value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" inputMode="numeric"
                  className="mt-5 w-full rounded-lg border border-border bg-input/40 px-3 py-3 text-center text-lg tracking-[0.3em] text-foreground outline-none placeholder:text-sm placeholder:tracking-normal placeholder:text-muted-foreground"
                />
                <button
                  onClick={verifyCode} disabled={code.length < 6 || wallet.embeddedBusy}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {wallet.embeddedBusy ? <Loader2 size={15} className="animate-spin" /> : "Verify code"}
                </button>
                {error && <p className="mt-3 text-center text-xs text-danger">{error}</p>}
              </motion.div>
            )}

            {/* ── Passkey: create or recover the wallet ────────────────── */}
            {step === "wallet" && (
              <motion.div key="wallet" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22 }} className="p-8">
                <div className="mb-6 flex items-center justify-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"><Fingerprint size={26} /></div>
                </div>
                <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">
                  {wallet.hasEmbeddedCredential ? "Unlock your wallet" : "Set up your wallet"}
                </h1>
                <p className="mx-auto mt-2 max-w-xs text-center text-sm leading-relaxed text-muted-foreground">
                  {wallet.hasEmbeddedCredential
                    ? "Confirm with your device to unlock the same wallet you already have."
                    : "Confirm with your device. Your wallet is created instantly — no seed phrase, nothing to write down."}
                </p>

                {!wallet.embeddedSupported ? (
                  <div className="mt-6 space-y-3">
                    <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      This device can&apos;t secure a wallet with a passkey. You can connect an existing wallet instead.
                    </p>
                    <Link href="/connect" className="flex w-full items-center justify-center rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground transition hover:border-primary/40">
                      Connect Existing Wallet
                    </Link>
                  </div>
                ) : (
                  <>
                    <button
                      onClick={finishWallet} disabled={wallet.embeddedBusy}
                      className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                    >
                      {wallet.embeddedBusy ? <Loader2 size={16} className="animate-spin" /> : <Fingerprint size={16} />}
                      {wallet.embeddedBusy ? "Waiting for your device…" : wallet.hasEmbeddedCredential ? "Unlock with passkey" : "Create my wallet"}
                    </button>
                    {error && <p className="mt-3 text-center text-xs text-danger">{error}</p>}
                    <p className="mt-3 text-center text-[11px] text-muted-foreground">
                      Face ID, Touch ID, or your device PIN — whatever your device uses.
                    </p>
                  </>
                )}
              </motion.div>
            )}

            {/* ── Done ─────────────────────────────────────────────────── */}
            {step === "done" && (
              <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }} className="p-8">
                <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }} className="mb-6 flex items-center justify-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success/12 text-success"><CheckCircle2 size={28} /></div>
                </motion.div>
                <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">Your wallet is ready</h1>
                <p className="mt-2 text-center font-mono text-xs text-muted-foreground">{wallet.address}</p>
                <p className="mt-3 text-center text-sm text-muted-foreground">Taking you to your dashboard…</p>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="border-t border-border px-8 py-5 text-center text-xs text-muted-foreground">
            <p className="flex items-center justify-center gap-1.5"><ShieldCheck size={12} /> PayAI never asks for your private key or seed phrase.</p>
          </div>
        </motion.div>
      </div>
    </main>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={null}>
      <AuthFlow />
    </Suspense>
  );
}
