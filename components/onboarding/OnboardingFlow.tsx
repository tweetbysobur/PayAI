"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  Sparkles, ShieldCheck, Lock, Repeat, ArrowLeftRight, LayoutDashboard,
  ArrowRight, CheckCircle2, Clock3, PlusCircle, Eye, Send,
} from "lucide-react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { MonadMark } from "@/components/MonadMark";
import { useOnboarding } from "@/lib/hooks/useOnboarding";
import { MONAD_CHAIN_NAME } from "@/lib/monad/public";

const TOTAL_STEPS = 5;

/** First-run onboarding — shown once per wallet after its first connection,
 *  never again after completion (or after picking a first action, which
 *  completes it implicitly). Reopened on demand via the sidebar's
 *  "Getting Started" link (see reopenOnboarding()). */
export function OnboardingFlow() {
  const wallet = useWallet();
  const identity = useIdentity(wallet.address);
  const router = useRouter();
  const { open, complete } = useOnboarding(wallet.address);
  const [step, setStep] = useState(1);

  if (!wallet.address) return null;

  function goTo(path: string) {
    complete();
    router.push(path);
  }

  function finish() {
    complete();
    setStep(1);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-panel shadow-2xl"
          >
            {/* Progress */}
            <div className="flex items-center gap-1.5 px-8 pt-6">
              {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                <span key={i} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${i < step ? "bg-primary" : "bg-border"}`} />
              ))}
            </div>

            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.div key="s1" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22 }} className="p-8">
                  <div className="mb-5 flex items-center justify-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"><Sparkles size={30} /></div>
                  </div>
                  <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">Welcome to PayAI</h1>
                  <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
                    PayAI lets you send, schedule, swap, and automate payments on Monad, all from your own wallet.
                  </p>
                  <div className="mt-6 grid grid-cols-2 gap-2.5">
                    {[
                      { icon: Send, label: "Send instantly" },
                      { icon: Repeat, label: "Automate payments" },
                      { icon: ArrowLeftRight, label: "Swap MON & USDC" },
                      { icon: ShieldCheck, label: "Stay in control" },
                    ].map((f) => (
                      <div key={f.label} className="flex items-center gap-2 rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-3 py-2.5 text-xs font-medium text-foreground">
                        <f.icon size={14} className="shrink-0 text-primary-ink" /> {f.label}
                      </div>
                    ))}
                  </div>
                  <div className="mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                    <Clock3 size={12} /> About 1 minute to get set up
                  </div>
                  <button onClick={() => setStep(2)} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                    Get started <ArrowRight size={15} />
                  </button>
                </motion.div>
              )}

              {step === 2 && (
                <motion.div key="s2" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22 }} className="p-8">
                  <div className="mb-5 flex items-center justify-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"><ShieldCheck size={30} /></div>
                  </div>
                  <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">Wallet & security</h1>
                  <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
                    Here&apos;s what&apos;s connected, and how PayAI protects you.
                  </p>

                  <div className="mt-6 flex items-center gap-3 rounded-xl border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-4 py-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success/12 text-success"><CheckCircle2 size={18} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm font-medium text-foreground">{identity.display}</p>
                      <p className="text-xs text-muted-foreground">Wallet connected</p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center gap-3 rounded-xl border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-4 py-3">
                    <span className={`flex h-9 w-9 items-center justify-center rounded-full ${wallet.isWrongNetwork ? "bg-warning/12 text-warning" : "bg-success/12 text-success"}`}>
                      <MonadMark size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{wallet.isWrongNetwork ? "Switch to " + MONAD_CHAIN_NAME : MONAD_CHAIN_NAME}</p>
                      <p className="text-xs text-muted-foreground">{wallet.isWrongNetwork ? "You'll be prompted after onboarding" : "Network confirmed"}</p>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2.5 text-xs text-foreground">
                    <div className="flex items-start gap-2.5"><Lock size={14} className="mt-0.5 shrink-0 text-primary-ink" /><span>PayAI never asks for, or stores, your private key or seed phrase.</span></div>
                    <div className="flex items-start gap-2.5"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-primary-ink" /><span>Every payment needs your approval in your wallet, unless you&apos;ve set up an automation with limits you chose in advance.</span></div>
                  </div>

                  <button onClick={() => setStep(3)} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                    Continue <ArrowRight size={15} />
                  </button>
                </motion.div>
              )}

              {step === 3 && (
                <motion.div key="s3" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22 }} className="p-8">
                  <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">Choose your first action</h1>
                  <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
                    Jump straight in, or explore first. Either way, PayAI is ready.
                  </p>
                  <div className="mt-6 grid grid-cols-2 gap-3">
                    {[
                      { icon: Send, title: "Send Payment", body: "Pay any wallet or name", href: "/dashboard/payments" },
                      { icon: Repeat, title: "Create Automation", body: "Recurring or scheduled", href: "/dashboard/automations" },
                      { icon: ArrowLeftRight, title: "Swap Tokens", body: "MON ↔ USDC instantly", href: "/dashboard/payments" },
                      { icon: LayoutDashboard, title: "Explore Dashboard", body: "Look around first", href: "/dashboard" },
                    ].map((a) => (
                      <button key={a.title} onClick={() => goTo(a.href)}
                        className="group flex flex-col items-start rounded-xl border border-border p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><a.icon size={16} /></span>
                        <span className="text-sm font-semibold text-foreground">{a.title}</span>
                        <span className="mt-0.5 text-xs text-muted-foreground">{a.body}</span>
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setStep(4)} className="mt-5 flex w-full items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-primary-ink">
                    Show me how automations work first <ArrowRight size={12} />
                  </button>
                </motion.div>
              )}

              {step === 4 && (
                <motion.div key="s4" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.22 }} className="p-8">
                  <div className="mb-5 flex items-center justify-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"><Repeat size={28} /></div>
                  </div>
                  <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">How automation works</h1>
                  <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
                    Every automation follows the same simple lifecycle.
                  </p>

                  <div className="relative mt-8 grid grid-cols-4 gap-2">
                    <div className="absolute left-[12.5%] right-[12.5%] top-5 h-px bg-border" />
                    {[
                      { icon: PlusCircle, label: "Create" },
                      { icon: Eye, label: "Monitor" },
                      { icon: Sparkles, label: "Execute" },
                      { icon: CheckCircle2, label: "Confirm" },
                    ].map((s, i) => (
                      <motion.div key={s.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08, duration: 0.3 }} className="relative z-10 flex flex-col items-center text-center">
                        <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-primary/40 bg-panel text-primary-ink"><s.icon size={16} /></span>
                        <span className="text-[11px] font-medium text-foreground">{s.label}</span>
                      </motion.div>
                    ))}
                  </div>
                  <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
                    You set the amount, recipient, and schedule once. PayAI watches for the right moment, executes on time, and confirms it on-chain, every time.
                  </p>
                  <button onClick={() => setStep(5)} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                    Continue <ArrowRight size={15} />
                  </button>
                </motion.div>
              )}

              {step === 5 && (
                <motion.div key="s5" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }} className="p-8">
                  <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }} className="mb-5 flex items-center justify-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-success/12 text-success"><CheckCircle2 size={30} /></div>
                  </motion.div>
                  <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">You&apos;re ready</h1>
                  <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
                    That&apos;s everything you need to know. Your dashboard is set up and waiting.
                  </p>
                  <button onClick={finish} className="mt-7 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                    Open Dashboard <ArrowRight size={15} />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
