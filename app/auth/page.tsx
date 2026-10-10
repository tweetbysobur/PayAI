"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { safeReturnPath } from "@/lib/platform/returnPath";
import { motion, AnimatePresence } from "motion/react";
import {
  ShieldCheck, ArrowRight, Loader2, ChevronLeft, ChevronDown,
  Fingerprint, AlertTriangle, Check,
  Zap, KeyRound, Puzzle, Repeat, Layers,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { SignInMark, glassSignInRow } from "@/components/auth/SignInMark";
import { FirstRunSteps } from "@/components/onboarding/FirstRunSteps";

const CONSENT_KEY = "payai_tos_accepted_v1";

type Step = "start" | "email-code" | "wallet" | "choice" | "creating" | "first-run";

/** Item 4 — the trust row under the auth options. Plain ticks, no colour
 *  blocks: the claims do the work, not the styling. */
const TRUST_POINTS = [
  { icon: Zap, label: "Wallet created in seconds" },
  { icon: KeyRound, label: "You own your funds" },
  { icon: Puzzle, label: "No browser extension required" },
  { icon: Repeat, label: "Built for Monad automation" },
  { icon: Layers, label: "Works with every PayAI feature" },
];

/** Item 5 — the collapsible "why", for people who want the detail before
 *  committing. Collapsed by default so it never slows down anyone who doesn't.
 *  The alternate-sign-in point is generated, not written by hand — naming
 *  "Google, Apple, X or Email" on a deployment with none of them configured
 *  would be the same false offer the buttons themselves no longer make. */
const WHY_POINTS_BASE = [
  "No browser wallet required",
  "Secure embedded wallet",
  "Built for automation",
  "Full ownership of your assets",
  "Works across every PayAI workflow",
];

function AuthFlow() {
  const wallet = useWalletService();
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState<Step>("start");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [newAddress, setNewAddress] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const err = params.get("error");
    if (err) {
      setError(
        err === "invalid_state" ? "That sign-in link expired. Please try again."
          : err === "apple_not_configured" ? "Continue with Apple is coming soon."
            : err,
      );
    }
    if (typeof window !== "undefined" && localStorage.getItem(CONSENT_KEY) === "1") setAgreed(true);
    // OAuth lands here with a session and no user gesture. A passkey ceremony
    // started from this effect is both unreliable (browsers reject it) and
    // dangerous (it used to register a brand-new passkey). The next screen
    // asks for one tap, then looks up an existing passkey before creating.
    if (params.get("step") === "wallet") { setAgreed(true); setStep("wallet"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  function rememberConsent() {
    if (agreed) localStorage.setItem(CONSENT_KEY, "1");
  }

  /** Looks up an existing PayAI passkey first. Creates one only when this
   *  device has none and — for a signed-in account — that account has no
   *  wallet yet. */
  async function openWallet(opts?: { create?: boolean; switchPasskey?: boolean }) {
    setError(null);
    setBlocked(false);
    rememberConsent();
    setStep("creating");
    try {
      const { address, created } = await wallet.setUpEmbeddedWallet(opts);
      if (created) {
        setNewAddress(address);
        setStep("first-run");
      } else {
        router.push(safeReturnPath(params.get("next")) ?? "/dashboard");
      }
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code?: string }).code) : "";
      if (code === "need-create" || code === "existing-account") {
        setBlocked(code === "existing-account");
        setError(code === "existing-account" ? (e instanceof Error ? e.message : null) : null);
        setStep("choice");
        return;
      }
      setError(e instanceof Error ? e.message : wallet.error ?? "Couldn't open your wallet. Please try again.");
      setStep(params.get("step") === "wallet" ? "wallet" : "start");
    }
  }

  async function sendCode() {
    setError(null);
    setPending("email");
    rememberConsent();
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
      setAgreed(true);
      setStep("wallet");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code.");
    }
  }

  // Unconfigured methods are left off entirely rather than shown disabled
  // with a "Soon" badge. A greyed-out button is still an offer — it just
  // moves the disappointment to the moment someone clicks it. Each one
  // reappears on its own the day this deployment gets real credentials;
  // nothing here needs to change to add it back.
  const social = (
    [
      { method: "google", label: "Google" },
      { method: "apple", label: "Apple" },
      { method: "x", label: "X" },
    ] as const
  ).filter((s) => wallet.authMethods[s.method]);
  const emailAvailable = wallet.authMethods.email;
  const hasAlternateSignIn = social.length > 0 || emailAvailable;
  const returning = wallet.hasEmbeddedCredential;

  // Same principle as the sign-in row above: name only what this deployment
  // can actually complete, in whatever order those methods are configured.
  const alternateNames = [...social.map((s) => s.label), ...(emailAvailable ? ["Email"] : [])];
  const whyPoints = alternateNames.length > 0
    ? [...WHY_POINTS_BASE.slice(0, 3), `Sign in with ${alternateNames.join(", ").replace(/, ([^,]*)$/, " or $1")}`, ...WHY_POINTS_BASE.slice(3)]
    : WHY_POINTS_BASE;

  return (
    <main className="relative flex min-h-screen flex-col overflow-clip bg-background">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-12%] h-[460px] w-[720px] -translate-x-1/2 rounded-full bg-primary/25 blur-[130px]" />
        <div className="absolute bottom-[-8%] right-[-6%] h-72 w-72 rounded-full bg-secondary/15 blur-[110px]" />
      </div>
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={28} />
          <span className="text-sm font-semibold text-foreground">PayAI</span>
        </Link>
        <Link href="/" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Back to home</Link>
      </header>

      <div className="flex flex-1 items-start justify-center px-5 py-8 sm:items-center sm:py-10">
        <div className="w-full max-w-md">
          <AnimatePresence mode="wait">
            {/* ── The single onboarding card ─────────────────────────────── */}
            {step === "start" && (
              <motion.div
                key="start"
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              >
                {/* Item 6 — trust badges above the card. Deliberately quiet:
                    hairline border, muted text, no coloured pills. */}
                <div className="mb-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5">
                  {[
                    { icon: <MonadMark size={11} />, label: "Built on Monad Mainnet" },
                    { icon: <ShieldCheck size={11} />, label: "Embedded wallet security" },
                    { icon: <KeyRound size={11} />, label: "Non-custodial" },
                  ].map((b) => (
                    <span key={b.label} className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                      {b.icon}{b.label}
                    </span>
                  ))}
                </div>

                <div className="relative overflow-hidden rounded-[22px] border border-white/10 bg-panel/55 shadow-[0_40px_100px_-42px_hsl(var(--primary)/0.7)] ring-1 ring-inset ring-white/[0.06] backdrop-blur-2xl">
                  <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/45 to-transparent" />
                  <div className="p-7 sm:p-8">
                    {/* Item 1 — hero */}
                    <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">
                      {returning ? "Welcome back" : "Your PayAI Wallet"}
                    </h1>
                    <p className="mx-auto mt-2 max-w-sm text-balance text-center text-sm leading-relaxed text-muted-foreground">
                      {returning
                        ? "Unlock your wallet with your passkey to pick up where you left off."
                        : "A wallet secured by your device's passkey — no seed phrase to write down."}
                    </p>
                    <p className="mx-auto mt-2 max-w-sm text-balance text-center text-xs leading-relaxed text-muted-foreground/80">
                      {returning
                        ? "See more than one passkey? Pick the original — a newer one is a different wallet."
                        : "If this device already has a PayAI passkey, that wallet opens instead of a new one."}
                    </p>

                    {/* Item 2 — primary CTA */}
                    <div className="mt-6">
                      <button
                        onClick={() => { void openWallet(); }}
                        disabled={!agreed || !wallet.embeddedSupported}
                        className="group flex w-full items-center gap-3 rounded-xl border border-primary/50 bg-primary px-4 py-3.5 text-left text-sm font-semibold text-primary-foreground transition-all duration-200 hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Fingerprint size={18} className="shrink-0" />
                        <span className="flex-1">{returning ? "Unlock PayAI Wallet" : "Continue with PayAI Wallet"}</span>
                        {!returning && (
                          <span className="hidden shrink-0 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[10px] font-medium min-[400px]:inline">Recommended</span>
                        )}
                        <ArrowRight size={15} className="shrink-0 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </button>
                      {returning && (
                        <button
                          type="button"
                          onClick={() => { void openWallet({ switchPasskey: true }); }}
                          disabled={!agreed || wallet.embeddedBusy}
                          className="mt-2 w-full text-center text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
                        >
                          Not this wallet? Use a different passkey
                        </button>
                      )}
                      {!wallet.embeddedSupported && (
                        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-warning">
                          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                          This device can&apos;t secure a wallet with a passkey. Connect an existing wallet below.
                        </p>
                      )}
                    </div>

                    {/* Social + email — only methods this deployment can
                        actually complete. Nothing reads "Not set up", and
                        nothing renders disabled with a "Soon" badge either:
                        an unconfigured method is left off the page entirely,
                        the same way the landing page now handles this list. */}
                    {hasAlternateSignIn && (
                      <>
                        <div className="my-5 flex items-center gap-3">
                          <div className="h-px flex-1 bg-border" />
                          <span className="text-[11px] text-muted-foreground">or continue with</span>
                          <div className="h-px flex-1 bg-border" />
                        </div>

                        {social.length > 0 && (
                          <div className="grid gap-2">
                            {social.map((s) => (
                              <button
                                key={s.method}
                                disabled={!agreed}
                                onClick={() => wallet.connectEmbeddedOAuth(s.method)}
                                title={`Continue with ${s.label}`}
                                className={glassSignInRow}
                              >
                                <SignInMark method={s.method} />
                                <span className="flex-1">Continue with {s.label}</span>
                                <ArrowRight size={14} className="shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
                              </button>
                            ))}
                          </div>
                        )}

                        {emailAvailable && (
                          <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.04] p-1.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] backdrop-blur-md">
                            <div className="flex items-center gap-2.5 px-1.5 py-1">
                              <SignInMark method="email" />
                              <input
                                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                                placeholder="you@example.com" disabled={!agreed}
                                className="w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed sm:text-sm"
                              />
                            </div>
                            <button
                              onClick={sendCode} disabled={!email.includes("@") || pending === "email" || !agreed}
                              className="mt-1 flex w-full items-center justify-center gap-2 rounded-[10px] border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {pending === "email" ? <Loader2 size={15} className="animate-spin" /> : <>Continue with Email <ArrowRight size={14} /></>}
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    {/* Item 10 — external wallet, clearly secondary. */}
                    <div className="mt-5 rounded-xl border border-border/70 bg-input/20 px-3.5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium text-foreground">Already have a wallet?</p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">MetaMask, Rabby, Backpack and more.</p>
                        </div>
                        <Link
                          href="/connect"
                          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                        >
                          Connect
                        </Link>
                      </div>
                    </div>

                    {/* Item 7 — terms, elegant and unobtrusive. */}
                    <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[11px] leading-relaxed text-muted-foreground">
                      <input
                        type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
                        className="mt-px h-3.5 w-3.5 shrink-0 rounded border-border bg-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <span>
                        I agree to PayAI&apos;s{" "}
                        <Link href="/terms" target="_blank" className="text-primary-ink hover:underline">Terms of Service</Link>{" "}
                        and <Link href="/privacy" target="_blank" className="text-primary-ink hover:underline">Privacy Policy</Link>.
                      </span>
                    </label>

                    {error && <p className="mt-3 text-center text-xs text-danger">{error}</p>}
                  </div>

                  {/* Item 4 — trust section */}
                  <div className="border-t border-border bg-input/20 px-7 py-5 sm:px-8">
                    <ul className="grid gap-2">
                      {TRUST_POINTS.map((t) => (
                        <li key={t.label} className="flex items-center gap-2.5 text-xs text-muted-foreground">
                          <Check size={13} className="shrink-0 text-primary-ink" />
                          {t.label}
                        </li>
                      ))}
                    </ul>

                    {/* Item 5 — collapsible why */}
                    <button
                      onClick={() => setShowWhy((v) => !v)}
                      aria-expanded={showWhy}
                      className="mt-4 flex w-full items-center justify-between rounded-lg text-[11px] font-medium text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Why use a PayAI Wallet?
                      <ChevronDown size={13} className={`transition-transform duration-200 ${showWhy ? "rotate-180" : ""}`} />
                    </button>
                    <AnimatePresence initial={false}>
                      {showWhy && (
                        <motion.ul
                          initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.22, ease: "easeOut" }}
                          className="overflow-hidden"
                        >
                          <div className="mt-2.5 grid gap-1.5">
                            {whyPoints.map((w) => (
                              <li key={w} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary-ink" />
                                {w}
                              </li>
                            ))}
                          </div>
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                  <ShieldCheck size={11} /> PayAI never asks for your private key or seed phrase.
                </p>
              </motion.div>
            )}

            {/* ── Email code ────────────────────────────────────────────── */}
            {step === "email-code" && (
              <motion.div
                key="code" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.25 }}
                className="relative overflow-hidden rounded-[22px] border border-white/10 bg-panel/55 p-8 shadow-[0_40px_100px_-42px_hsl(var(--primary)/0.7)] ring-1 ring-inset ring-white/[0.06] backdrop-blur-2xl"
              >
                <button onClick={() => setStep("start")} className="mb-4 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronLeft size={13} /> Back
                </button>
                <div className="mx-auto mb-5 flex justify-center">
                  <SignInMark method="email" size={18} />
                </div>
                <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">Check your email</h1>
                <p className="mt-2 text-center text-sm text-muted-foreground">We sent a 6-digit code to {email}.</p>
                <input
                  value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" inputMode="numeric"
                  className="mt-5 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-center text-lg tracking-[0.3em] text-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] outline-none backdrop-blur-md placeholder:text-sm placeholder:tracking-normal placeholder:text-muted-foreground"
                />
                <button
                  onClick={verifyCode} disabled={code.length < 6 || wallet.embeddedBusy}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {wallet.embeddedBusy ? <Loader2 size={15} className="animate-spin" /> : "Verify code"}
                </button>
                {error && <p className="mt-3 text-center text-xs text-danger">{error}</p>}
              </motion.div>
            )}

            {/* ── After Google / email: one tap, then the passkey ─────────── */}
            {step === "wallet" && (
              <motion.div
                key="wallet" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden rounded-2xl border border-border bg-panel p-6 shadow-2xl sm:p-8"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Fingerprint size={20} />
                </span>
                <h1 className="mt-5 text-xl font-semibold tracking-tight text-foreground">Open your wallet</h1>
                <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
                  You&apos;re signed in. Confirm with the passkey on this device to open your PayAI Wallet.
                </p>
                <p className="mt-3 text-pretty text-xs leading-relaxed text-muted-foreground/80">
                  A new wallet is only created if you don&apos;t have one yet.
                </p>
                <button
                  onClick={() => { void openWallet(); }}
                  disabled={wallet.embeddedBusy || !wallet.embeddedSupported}
                  className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {wallet.embeddedBusy ? <Loader2 size={15} className="animate-spin" /> : <>Continue <ArrowRight size={14} /></>}
                </button>
                <button
                  type="button"
                  onClick={() => { void openWallet({ switchPasskey: true }); }}
                  disabled={wallet.embeddedBusy}
                  className="mt-3 flex h-10 w-full items-center justify-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
                >
                  I have more than one passkey
                </button>
                {error && <p className="mt-3 text-sm text-danger">{error}</p>}
              </motion.div>
            )}

            {/* ── Existing passkey wasn't used. Don't create unless asked. ── */}
            {step === "choice" && (
              <motion.div
                key="choice" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden rounded-2xl border border-border bg-panel p-6 shadow-2xl sm:p-8"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Fingerprint size={20} />
                </span>
                <h1 className="mt-5 text-balance text-xl font-semibold tracking-tight text-foreground">
                  {blocked ? "This account already has a wallet" : "No passkey was selected"}
                </h1>
                {blocked ? (
                  <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
                    {error ?? "Unlock the passkey that belongs to this sign-in. A new one would be a different, empty wallet."}
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
                      Used PayAI before? Try again and pick that passkey — it may be saved in iCloud Keychain or Google Password Manager.
                    </p>
                    <p className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-pretty text-xs leading-relaxed text-muted-foreground">
                      A new passkey creates a new, empty wallet. It doesn&apos;t move funds from an old one.
                    </p>
                  </>
                )}
                <button
                  onClick={() => { void openWallet({ switchPasskey: true }); }}
                  className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-95"
                >
                  <Fingerprint size={16} /> Use my existing passkey
                </button>
                {!blocked && (
                  <button
                    onClick={() => { void openWallet({ create: true }); }}
                    className="mt-2.5 flex h-12 w-full items-center justify-center rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:border-primary/40"
                  >
                    I&apos;m new — create a wallet
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { setError(null); setStep("start"); }}
                  className="mt-3 flex h-10 w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft size={13} /> Back
                </button>
              </motion.div>
            )}

            {/* ── Item 12 — creating state ──────────────────────────────── */}
            {step === "creating" && (
              <motion.div
                key="creating" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="overflow-hidden rounded-2xl border border-border bg-panel px-8 py-14 text-center shadow-2xl"
              >
                <div className="relative mx-auto mb-6 flex h-16 w-16 items-center justify-center">
                  <motion.span
                    className="absolute inset-0 rounded-2xl border-2 border-primary/30"
                    animate={{ scale: [1, 1.12, 1], opacity: [0.5, 0.15, 0.5] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <span className="flex h-16 w-16 items-center justify-center text-primary">
                    <Fingerprint size={30} />
                  </span>
                </div>
                <p className="text-base font-semibold text-foreground">Confirm on your device</p>
                <p className="mx-auto mt-1.5 max-w-xs text-balance text-sm leading-relaxed text-muted-foreground">
                  Use Face ID, Touch ID or your device PIN.
                </p>
                <p className="mx-auto mt-2 max-w-xs text-balance text-xs leading-relaxed text-muted-foreground/80">
                  Have more than one PayAI passkey? Choose the original.
                </p>
              </motion.div>
            )}

            {/* ── Items 8 + 13 — success, then guided first run ──────────── */}
            {step === "first-run" && newAddress && (
              <FirstRunSteps
                key="first-run"
                address={newAddress}
                onFinish={() => router.push(safeReturnPath(params.get("next")) ?? "/dashboard")}
              />
            )}
          </AnimatePresence>
        </div>
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
