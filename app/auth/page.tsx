"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  Sparkles, Wallet as WalletIcon, ArrowRight, Loader2, ShieldCheck,
  Mail, CheckCircle2, ChevronLeft,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { BrandIcon } from "@/components/BrandIcons";

type Step = "choice" | "social" | "email-code" | "connected";

/** The premium front door: "Continue with Google" → wallet created
 *  automatically → dashboard, with zero blockchain jargon in between. Option
 *  2 ("Connect Existing Wallet") hands off to the existing /connect flow
 *  unchanged — both paths converge on the same Wallet Service, so nothing
 *  downstream (automations, the AI assistant) needs to know which one ran. */
export default function AuthPage() {
  const wallet = useWalletService();
  const router = useRouter();
  const [step, setStep] = useState<Step>("choice");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailSent, setEmailSent] = useState(false);

  useEffect(() => {
    if (wallet.kind === "embedded" && step !== "connected") setStep("connected");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.kind]);

  useEffect(() => {
    if (step === "connected") {
      const t = setTimeout(() => router.push("/dashboard"), 1800);
      return () => clearTimeout(t);
    }
  }, [step, router]);

  async function sendCode() {
    setError(null);
    try {
      await wallet.requestEmailCode(email);
      setEmailSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the code.");
    }
  }

  async function verifyCode() {
    setError(null);
    try {
      await wallet.verifyEmailCode(email, code);
      setStep("connected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code.");
    }
  }

  const social: { method: "google" | "apple" | "x"; label: string; available: boolean }[] = [
    { method: "google", label: "Continue with Google", available: wallet.authMethods.google },
    { method: "apple", label: "Continue with Apple", available: wallet.authMethods.apple },
    { method: "x", label: "Continue with X", available: wallet.authMethods.x },
  ];

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
          className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
        >
          <AnimatePresence mode="wait">
            {step === "choice" && (
              <motion.div key="choice" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.25 }} className="p-8">
                <div className="mb-6 flex items-center justify-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink">
                    <Sparkles size={26} />
                  </div>
                </div>
                <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">Get started with PayAI</h1>
                <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">
                  No browser wallet required. Sign in and PayAI sets up your wallet automatically.
                </p>

                <div className="mt-6 space-y-3">
                  <button
                    onClick={() => setStep("social")}
                    className="group relative flex w-full flex-col items-start gap-1 rounded-xl border-2 border-primary/50 bg-gradient-to-b from-primary/[0.08] to-transparent px-4 py-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-primary"
                  >
                    <span className="absolute right-3 top-3 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary-ink">Recommended</span>
                    <span className="flex items-center gap-2 text-sm font-semibold text-foreground"><WalletIcon size={15} className="text-primary-ink" /> Use PayAI Wallet</span>
                    <span className="text-xs text-muted-foreground">Embedded — created instantly with your Google, Apple, X, or email sign-in.</span>
                  </button>

                  <Link
                    href="/connect"
                    className="group flex w-full flex-col items-start gap-1 rounded-xl border border-border px-4 py-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40"
                  >
                    <span className="text-sm font-semibold text-foreground">Connect Existing Wallet</span>
                    <span className="text-xs text-muted-foreground">MetaMask, Rabby, Backpack, WalletConnect, and more.</span>
                  </Link>
                </div>

                {!wallet.embeddedAvailable && (
                  <p className="mt-4 text-center text-[11px] text-muted-foreground">
                    Embedded wallets are being finalized on this deployment — sign-in above will explain what&apos;s pending.
                  </p>
                )}
              </motion.div>
            )}

            {step === "social" && (
              <motion.div key="social" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.25 }} className="p-8">
                <button onClick={() => setStep("choice")} className="mb-4 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronLeft size={13} /> Back
                </button>
                <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">Sign in to PayAI</h2>
                <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">Your wallet is created automatically — no seed phrase, nothing to install.</p>

                <div className="mt-6 space-y-2.5">
                  {social.map((s) => (
                    <button
                      key={s.method}
                      onClick={() => (s.available ? wallet.connectEmbeddedOAuth(s.method) : setError(`${s.label} isn't set up on this deployment yet.`))}
                      className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm font-medium text-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40 disabled:opacity-50"
                    >
                      <BrandIcon name={s.method} size={16} />
                      <span className="flex-1 text-left">{s.label}</span>
                      {!s.available && <span className="text-[10px] font-medium text-muted-foreground">Not set up</span>}
                    </button>
                  ))}

                  <div className="flex items-center gap-3 py-0.5">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[11px] text-muted-foreground">or</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  {!emailSent ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 rounded-lg border border-border bg-input/40 px-3 py-2.5">
                        <Mail size={14} className="text-muted-foreground" />
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="you@example.com"
                          className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                        />
                      </div>
                      <button
                        onClick={() => (wallet.authMethods.email ? sendCode() : setError("Continue with email isn't set up on this deployment yet."))}
                        disabled={!email.includes("@") || wallet.embeddedBusy}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Continue with Email <ArrowRight size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-center text-xs text-muted-foreground">Enter the code sent to {email}.</p>
                      <input
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder="6-digit code"
                        className="w-full rounded-lg border border-border bg-input/40 px-3 py-2.5 text-center text-sm text-foreground outline-none placeholder:text-muted-foreground"
                      />
                      <button
                        onClick={verifyCode}
                        disabled={code.length < 4 || wallet.embeddedBusy}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {wallet.embeddedBusy ? <Loader2 size={15} className="animate-spin" /> : "Verify code"}
                      </button>
                    </div>
                  )}

                  {error && <p className="text-center text-xs text-danger">{error}</p>}
                </div>
              </motion.div>
            )}

            {step === "connected" && (
              <motion.div key="connected" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} className="p-8">
                <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }} className="mb-6 flex items-center justify-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success/12 text-success">
                    <CheckCircle2 size={28} />
                  </div>
                </motion.div>
                <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">Your wallet is ready</h2>
                <p className="mt-2 text-center text-sm leading-relaxed text-muted-foreground">Taking you to your dashboard…</p>
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
