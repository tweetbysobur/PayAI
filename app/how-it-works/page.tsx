"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight, Sparkles, Wallet, Lock, CheckCircle2 } from "lucide-react";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { AutomationTimelineSection, SecuritySection, WhyMonadSection } from "@/components/landing/MarketingSections";
import { DeveloperApi, EcosystemIntegrations } from "@/components/landing/PlatformSections";

/**
 * /how-it-works — answers "how does this actually work?"
 *
 * The mechanics: the seven stages of an automation, the two execution modes,
 * what secures it, why Monad, and the developer surface. All previously on the
 * landing page, where they competed with the pitch.
 *
 * The execution-mode comparison is NEW here and belongs on this page rather
 * than /product: choosing Wallet Automation vs Reserved Funds is the single
 * decision a user has to understand before they trust the engine with money,
 * and the landing page only ever named the two modes without contrasting them.
 */

const MODES = [
  {
    icon: Wallet,
    name: "Wallet Automation",
    tagline: "Funds stay in your wallet",
    points: [
      "You approve a spending allowance once; nothing moves until a run fires.",
      "Each run pulls only the exact amount due, never more.",
      "Revoke the approval at any time and the automation simply stops.",
      "Required for Bulk Payments.",
    ],
    note: "Best when you want to keep custody and flexibility.",
  },
  {
    icon: Lock,
    name: "Reserved Funds",
    tagline: "Execution is guaranteed",
    points: [
      "Funds are set aside up front in the AutomationVault contract.",
      "The reservation is locked to the recipient you chose — it can only pay them.",
      "A run cannot fail because your balance changed later.",
      "Refund whatever is unspent, whenever you want.",
    ],
    note: "Best when a payment absolutely must go out on time.",
  },
];

export default function HowItWorksPage() {
  return (
    <main className="min-h-screen bg-background">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden">
        <div className="absolute left-1/2 top-[-180px] h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-primary/10 blur-[100px]" />
      </div>

      <SiteNav />

      <section className="relative z-10 mx-auto max-w-4xl px-6 pb-4 pt-12 text-center sm:pt-16">
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-ink">How it works</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tighter text-foreground sm:text-5xl">
            Approve once. It runs itself.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground">
            An automation is a set of terms you sign with your own wallet. PayAI can execute
            those terms on schedule and can never exceed them.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/auth" className="flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              <Sparkles size={15} /> Launch App
            </Link>
            <Link href="/product" className="flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input">
              See the product <ArrowRight size={14} className="text-primary-ink" />
            </Link>
          </div>
        </motion.div>
      </section>

      <AutomationTimelineSection />

      {/* Execution modes — the one decision a user must understand. */}
      <section id="execution-modes" className="border-t border-border py-24 sm:py-28">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }} className="mb-12 text-center">
            <h2 className="text-3xl font-semibold tracking-tighter text-foreground sm:text-4xl">Two ways to fund an automation</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              You choose per automation. Both are non-custodial — PayAI never holds your funds in either mode.
            </p>
          </motion.div>

          <div className="grid gap-5 lg:grid-cols-2">
            {MODES.map((m, i) => (
              <motion.div
                key={m.name}
                initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ delay: i * 0.08, duration: 0.45, ease: "easeOut" }}
                className="flex flex-col rounded-2xl border border-border bg-panel/50 p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 sm:p-7"
              >
                <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary-ink">
                  <m.icon size={18} />
                </span>
                <h3 className="text-lg font-semibold tracking-tight text-foreground">{m.name}</h3>
                <p className="mt-1 text-sm font-medium text-primary-ink">{m.tagline}</p>
                <ul className="mt-5 space-y-2.5">
                  {m.points.map((p) => (
                    <li key={p} className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
                      <CheckCircle2 size={13} className="mt-[5px] shrink-0 text-primary-ink" />
                      {p}
                    </li>
                  ))}
                </ul>
                <p className="mt-5 border-t border-border/60 pt-4 text-xs text-muted-foreground">{m.note}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <SecuritySection />
      <WhyMonadSection />
      <DeveloperApi />
      <EcosystemIntegrations />

      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}>
          <h2 className="text-3xl font-semibold tracking-tighter text-foreground sm:text-4xl">
            Ready to automate?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Connect your wallet and build your first automation in a couple of minutes.
          </p>
          <div className="mt-8">
            <Link href="/auth" className="inline-flex rounded-lg bg-primary px-6 py-3.5 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              Start automating payments
            </Link>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Non-custodial · No platform fee during beta · Monad Mainnet
          </p>
        </motion.div>
      </section>

      <SiteFooter />
    </main>
  );
}
