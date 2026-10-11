"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { useOnboarding } from "@/lib/hooks/useOnboarding";
import { MONAD_CHAIN_NAME } from "@/lib/monad/public";
import { LogoMark } from "@/components/Logo";
import { startGuidedTour } from "@/components/onboarding/TourOverlay";

/**
 * The welcome — shown at the first visit of each day (useOnboarding), so new
 * users and anyone returning after time away see it; closed for the rest of
 * the day once finished or skipped. Reopened on demand from the sidebar's
 * "Getting Started" link (see reopenOnboarding()).
 *
 * Four short steps — Welcome, Your wallet, Automations, Get started — each a
 * few plain points, no worked examples. It ends in Ask PayAI, or on desktop
 * can hand over to the guided sidebar tour. It never teaches how to operate a
 * wallet.
 *
 * Design: PayAI's own colours and nothing else. A purple brand rail (logo,
 * the four steps, where you are) beside a black content pane; on a phone the
 * rail collapses to a purple header. No illustrations, sparkles or icon
 * grids — numbered steps and plain sentences, the way a payments product
 * explains itself.
 */

const STEPS = ["Welcome", "Your wallet", "Automations", "Get started"] as const;

export function OnboardingFlow() {
  const wallet = useWallet();
  const identity = useIdentity(wallet.address);
  const router = useRouter();
  // Keyed on the ACCOUNT, not whichever wallet is currently acting: attaching
  // a second wallet must not replay the introduction.
  const { open, complete } = useOnboarding(wallet.accountAddress ?? wallet.address);
  const [step, setStep] = useState(0);

  if (!wallet.address) return null;

  function close() { complete(); setStep(0); }
  /** Finish in Ask PayAI — the one thing the welcome teaches is "say what
   *  you want done". */
  function start() {
    close();
    router.push("/dashboard/ask");
  }
  const last = step === STEPS.length - 1;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/80 p-2 sm:items-center sm:p-6"
        >
          <motion.div
            role="dialog" aria-modal="true" aria-labelledby="onboarding-title"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="grid max-h-[94dvh] w-full max-w-3xl overflow-hidden rounded-xl border border-primary/40 bg-black md:grid-cols-[15rem_minmax(0,1fr)]"
          >
            {/* Brand rail — purple. */}
            <aside className="flex flex-col bg-primary px-4 py-3 text-white md:p-6">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-black md:h-9 md:w-9"><LogoMark size={16} className="text-primary-ink" /></span>
                  <span className="text-sm font-semibold">PayAI</span>
                </span>
                <button type="button" onClick={close} className="rounded-md px-2 py-1 text-xs font-medium text-white/80 transition-colors hover:bg-black/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white md:hidden">
                  Skip
                </button>
              </div>
              {/* Phone: a progress bar. Desktop: the step list. */}
              <div className="mt-3 flex gap-1.5 md:hidden" aria-hidden>
                {STEPS.map((s, i) => <span key={s} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-white" : "bg-black/30"}`} />)}
              </div>
              <ol className="mt-10 hidden space-y-1 md:block">
                {STEPS.map((s, i) => (
                  <li key={s} aria-current={i === step ? "step" : undefined} className={`flex items-center gap-3 rounded-md px-2 py-2 text-sm ${i === step ? "bg-black/25 font-medium text-white" : i < step ? "text-white/80" : "text-white/55"}`}>
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${i < step ? "bg-white text-primary" : i === step ? "bg-black text-white" : "border border-white/40"}`}>
                      {i < step ? <Check size={12} strokeWidth={3} /> : i + 1}
                    </span>
                    {s}
                  </li>
                ))}
              </ol>
              <p className="mt-auto hidden pt-10 text-xs leading-relaxed text-white/75 md:block">Make an intent and get your onchain execution done in seconds.</p>
            </aside>

            {/* Content — black. */}
            <div className="flex min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:p-8">
                <p className="text-xs font-medium text-primary-ink">Step {step + 1} of {STEPS.length}</p>
                <AnimatePresence mode="wait">
                  <motion.div key={step} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                    {step === 0 && (
                      <>
                        <h1 id="onboarding-title" className="mt-1.5 text-xl font-semibold tracking-tight text-white sm:mt-2 sm:text-3xl">Welcome to PayAI</h1>
                        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground sm:mt-2 sm:text-sm">Make an intent and get your onchain execution done in seconds — on {MONAD_CHAIN_NAME}, from your own wallet.</p>
                        <Numbered items={[
                          ["Say what you want", "In plain English."],
                          ["Review the plan", "Every action, amount and recipient, in order, before anything runs."],
                          ["Sign and it\u2019s done", "Your wallet signs, Monad settles, you get the receipt."],
                        ]} />
                      </>
                    )}
                    {step === 1 && (
                      <>
                        <h1 id="onboarding-title" className="mt-1.5 text-xl font-semibold tracking-tight text-white sm:mt-2 sm:text-3xl">Your wallet stays in control</h1>
                        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground sm:mt-2 sm:text-sm">PayAI prepares the action. Only your wallet can approve it.</p>
                        <dl className="mt-4 divide-y divide-border rounded-lg border border-border">
                          <div className="flex items-center justify-between gap-4 px-4 py-3">
                            <dt className="text-xs text-muted-foreground">Wallet</dt>
                            <dd className="truncate font-mono text-sm text-white">{identity.display}</dd>
                          </div>
                          <div className="flex items-center justify-between gap-4 px-4 py-3">
                            <dt className="text-xs text-muted-foreground">Network</dt>
                            <dd className={`text-sm ${wallet.isWrongNetwork ? "text-danger" : "text-white"}`}>
                              {wallet.isWrongNetwork ? `Wrong network — switch to ${MONAD_CHAIN_NAME}` : MONAD_CHAIN_NAME}
                            </dd>
                          </div>
                        </dl>
                        <Numbered items={[
                          ["Your keys stay yours", "PayAI never asks for or stores your private key or seed phrase."],
                          ["Nothing runs without you", "Every action you start waits for your signature."],
                        ]} />
                      </>
                    )}
                    {step === 2 && (
                      <>
                        <h1 id="onboarding-title" className="mt-1.5 text-xl font-semibold tracking-tight text-white sm:mt-2 sm:text-3xl">Automations</h1>
                        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground sm:mt-2 sm:text-sm">Set a payment once, and it runs on schedule.</p>
                        <Numbered items={[
                          ["Schedule or repeat", "One-time, daily, weekly or monthly."],
                          ["Within your limits", "Runs from a capped agent wallet, only within the limits you approve."],
                          ["Always yours to stop", "Pause, edit or cancel any automation at any time."],
                        ]} />
                      </>
                    )}
                    {step === 3 && (
                      <>
                        <h1 id="onboarding-title" className="mt-1.5 text-xl font-semibold tracking-tight text-white sm:mt-2 sm:text-3xl">You&apos;re ready</h1>
                        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground sm:mt-2 sm:text-sm">Three ways to begin.</p>
                        <Numbered items={[
                          ["Open Ask PayAI", "Say what you want done."],
                          ["Add funds", "Deposit MON or USDC to your wallet."],
                          ["Take the tour", "A quick look around the app."],
                        ]} />
                        {/* Desktop only: the tour spotlights the sidebar, which a phone doesn't show. */}
                        <button type="button" onClick={() => { close(); startGuidedTour(); }} className="mt-5 hidden h-9 items-center rounded-md border border-border px-3 text-xs font-medium text-white transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex">
                          Take the tour
                        </button>
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-8 sm:py-4">
                {step > 0 ? (
                  <button type="button" onClick={() => setStep(step - 1)} className="inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-input hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <ArrowLeft size={14} aria-hidden /> Back
                  </button>
                ) : (
                  <button type="button" onClick={close} className="hidden h-10 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-input hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex">
                    Skip
                  </button>
                )}
                {!last ? (
                  <button type="button" onClick={() => setStep(step + 1)} className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-5 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-black">
                    {step === 0 ? "Get started" : "Continue"} <ArrowRight size={14} aria-hidden />
                  </button>
                ) : (
                  <button type="button" onClick={start} className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-5 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-black">
                    Open Ask PayAI <ArrowRight size={14} aria-hidden />
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Numbered({ items }: { items: [string, string][] }) {
  return (
    <ol className="mt-4 space-y-3 sm:mt-6 sm:space-y-4">
      {items.map(([title, body], i) => (
        <li key={title} className="flex gap-4">
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-white">{i + 1}</span>
          <div className="min-w-0 pt-0.5">
            <p className="text-sm font-medium text-white">{title}</p>
            <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground sm:text-sm sm:leading-relaxed">{body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
