"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  PartyPopper, Copy, Check, ArrowRight, ArrowDownLeft, LayoutDashboard,
  Building2, Rocket, Landmark, Gift, Sparkles, Wallet as WalletIcon,
  Send, ArrowLeftRight,
} from "lucide-react";
import { useToast } from "@/components/Toast";
import { ChooseUsername } from "@/components/onboarding/ChooseUsername";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import dynamic from "next/dynamic";

const ReceiveModal = dynamic(() => import("@/components/dashboard/ReceiveModal").then((m) => m.ReceiveModal), { ssr: false });

/**
 * What happens immediately after a wallet is created: a real success moment,
 * then two short steps that answer "what now?" — fund it, then automate
 * something. Landing straight on an empty dashboard is the thing this
 * deliberately avoids.
 *
 * Three steps, no more. Anything longer stops being onboarding and starts
 * being a form.
 */

/** The four starting points named in the sprint. `soon` mirrors the template
 *  catalog's own coming_soon status rather than inventing a second source of
 *  truth — a template that isn't safe to run yet must not look runnable. */
const STARTERS: { id: string; name: string; blurb: string; icon: typeof Building2; soon: boolean; href: string }[] = [
  { id: "payroll", name: "Payroll", blurb: "Salaries on a fixed cycle.", icon: Building2, soon: true, href: "/dashboard/automations" },
  { id: "launchpad", name: "Launchpad Distribution", blurb: "Distribute tokens to contributors.", icon: Rocket, soon: true, href: "/dashboard/automations" },
  { id: "treasury", name: "Treasury", blurb: "Scheduled treasury movements.", icon: Landmark, soon: true, href: "/dashboard/automations" },
  { id: "rewards", name: "Community Rewards", blurb: "Reward many wallets at once.", icon: Gift, soon: true, href: "/dashboard/automations" },
];

/** Real, usable-right-now actions — not automation templates. Most of what
 *  this step used to offer was "Coming soon," which left a first-time user
 *  with almost nothing to actually click. These work today. */
const QUICK_ACTIONS: { id: string; name: string; blurb: string; icon: typeof Send; href: string }[] = [
  { id: "send", name: "Send Payment", blurb: "Pay any wallet or .nad name.", icon: Send, href: "/dashboard/payments" },
  { id: "swap", name: "Swap Tokens", blurb: "MON ↔ USDC instantly.", icon: ArrowLeftRight, href: "/dashboard/payments" },
  { id: "explore", name: "Explore Dashboard", blurb: "See balances, activity, and more.", icon: LayoutDashboard, href: "/dashboard" },
];

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function FirstRunSteps({ address, onFinish }: { address: string; onFinish: () => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [copied, setCopied] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  function copyAddress() {
    navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      toast("Wallet address copied");
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
    >
      {/* Progress — three quiet ticks, not a loud stepper. */}
      <div className="flex items-center gap-1.5 px-7 pt-6 sm:px-8">
        {[1, 2, 3].map((i) => (
          <span key={i} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${i <= step ? "bg-primary" : "bg-border"}`} />
        ))}
      </div>

      <AnimatePresence mode="wait">
        {/* ── Step 1 — Wallet created ─────────────────────────────────── */}
        {step === 1 && (
          <motion.div
            key="s1" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.22 }} className="p-7 sm:p-8"
          >
            <motion.div
              initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 240, damping: 18 }}
              className="mb-5 flex items-center justify-center"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-success/12 text-success">
                <PartyPopper size={30} />
              </span>
            </motion.div>

            <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">Welcome to PayAI</h1>
            <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
              Your embedded wallet has been created successfully. It&apos;s yours — PayAI can&apos;t move funds without you.
            </p>

            <div className="mt-5 rounded-xl border border-border bg-input/30 px-3.5 py-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Wallet address</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 truncate font-mono text-sm text-foreground" title={address}>{short(address)}</code>
                <button
                  onClick={copyAddress}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground transition hover:border-primary/40"
                >
                  {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <a
                href={`${MONAD_EXPLORER}/address/${address}`} target="_blank" rel="noreferrer"
                className="mt-1.5 inline-block text-[11px] text-primary-ink hover:underline"
              >
                View on explorer ↗
              </a>
            </div>

            <div className="mt-4">
              <ChooseUsername address={address} />
            </div>

            <button
              onClick={() => setStep(2)}
              className="group mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              Continue <ArrowRight size={15} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
            <button onClick={onFinish} className="mt-2 w-full rounded-lg py-2 text-[11px] text-muted-foreground transition hover:text-foreground">
              Skip to dashboard
            </button>
          </motion.div>
        )}

        {/* ── Step 2 — Fund your wallet ───────────────────────────────── */}
        {step === 2 && (
          <motion.div
            key="s2" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.22 }} className="p-7 sm:p-8"
          >
            <div className="mb-5 flex items-center justify-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink">
                <ArrowDownLeft size={26} />
              </span>
            </div>
            <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">Fund your wallet</h1>
            <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
              Deposit MON or any supported Monad token to start sending and automating. You can always do this later.
            </p>

            <button
              onClick={() => setReceiveOpen(true)}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              <ArrowDownLeft size={15} /> Show deposit address
            </button>
            <button
              onClick={copyAddress}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-input/40"
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />} {copied ? "Copied" : "Copy address"}
            </button>

            <div className="mt-5 flex gap-2">
              <button onClick={() => setStep(1)} className="flex-1 rounded-lg border border-border px-3 py-2.5 text-xs font-medium text-muted-foreground transition hover:text-foreground">
                Back
              </button>
              <button onClick={() => setStep(3)} className="flex-1 rounded-lg border border-border px-3 py-2.5 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-input/40">
                Next
              </button>
            </div>
          </motion.div>
        )}

        {/* ── Step 3 — First action ───────────────────────────────────── */}
        {step === 3 && (
          <motion.div
            key="s3" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.22 }} className="p-7 sm:p-8"
          >
            <div className="mb-5 flex items-center justify-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink">
                <Sparkles size={26} />
              </span>
            </div>
            <h1 className="text-center text-xl font-semibold tracking-tight text-foreground">What would you like to do first?</h1>
            <p className="mx-auto mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
              Your wallet is funded and ready. Send a payment right now, or set up something recurring — either way takes under a minute.
            </p>

            <div className="mt-5 grid gap-2 sm:grid-cols-3">
              {QUICK_ACTIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <Link
                    key={a.id}
                    href={a.href}
                    className="flex flex-col items-start gap-2 rounded-xl border border-border px-3.5 py-3 text-left transition-all duration-150 hover:border-primary/40 hover:bg-input/40"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><Icon size={16} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{a.name}</span>
                      <span className="block text-[11px] text-muted-foreground">{a.blurb}</span>
                    </span>
                  </Link>
                );
              })}
            </div>

            <p className="mb-1.5 mt-6 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Or automate it</p>
            <div className="grid gap-2">
              {STARTERS.map((t) => {
                const Icon = t.icon;
                const row = (
                  <>
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-input text-muted-foreground">
                      <Icon size={16} />
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block text-sm font-medium text-foreground">{t.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{t.blurb}</span>
                    </span>
                    {t.soon
                      ? <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Coming soon</span>
                      : <ArrowRight size={14} className="shrink-0 text-muted-foreground" />}
                  </>
                );
                return t.soon ? (
                  <div key={t.id} className="flex cursor-not-allowed items-center gap-3 rounded-xl border border-border px-3.5 py-3 opacity-60">{row}</div>
                ) : (
                  <Link key={t.id} href={t.href} className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3 transition-all duration-150 hover:border-primary/40 hover:bg-input/40">{row}</Link>
                );
              })}

              <Link
                href="/dashboard/automations"
                className="group flex items-center gap-3 rounded-xl border-2 border-primary/40 bg-gradient-to-b from-primary/[0.06] to-transparent px-3.5 py-3 transition-all duration-150 hover:border-primary"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary-ink"><WalletIcon size={16} /></span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block text-sm font-semibold text-foreground">Build a custom automation</span>
                  <span className="block truncate text-[11px] text-muted-foreground">Available now — set your own schedule and amount.</span>
                </span>
                <ArrowRight size={14} className="shrink-0 text-primary-ink transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
            </div>

            <button
              onClick={onFinish}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-input/40"
            >
              <LayoutDashboard size={15} /> Go to dashboard
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </motion.div>
  );
}
