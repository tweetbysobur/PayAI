"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Wallet, Lock, CheckCircle2 } from "lucide-react";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { AutomationTimelineSection, SecuritySection } from "@/components/landing/MarketingSections";
import { AIOperatorSection } from "@/components/landing/PlatformOverview";
import { HowItWorksSteps } from "@/components/landing/HowItWorksSteps";
import { CapabilityGrid } from "@/components/landing/CapabilityGrid";
import { geist, geistMono } from "@/components/landing/fonts";
import { DeveloperApi, EcosystemIntegrations } from "@/components/landing/PlatformSections";

/**
 * /how-it-works — answers "how does this actually work?"
 *
 * Leads with the three steps (describe → review → approve and execute) and
 * the full capability grid — both moved here from the landing page, which now
 * only previews them. Then the mechanics: Ask PayAI's preparation step, how an
 * automation runs and is funded, what secures it, and the developer surface.
 * "Why Monad" lives on /product.
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
    tagline: "Funds set aside up front",
    points: [
      "Funds are set aside up front in the AutomationVault contract.",
      "The reservation is locked to the recipient you chose — it can only pay them.",
      "A run doesn't depend on what your wallet holds when it fires.",
      "Refund whatever is unspent, whenever you want.",
    ],
    note: "Best when a payment must not depend on your wallet balance at run time.",
  },
];

export default function HowItWorksPage() {
  return (
    <main
      className={`${geist.className} ${geistMono.variable} min-h-screen overflow-x-hidden bg-background antialiased`}
      style={{ "--font-mono": "var(--font-geist-mono)" } as React.CSSProperties}
    >
      <SiteNav />

      <HowItWorksSteps />
      <CapabilityGrid />
      <AIOperatorSection />
      <AutomationTimelineSection />

      {/* Execution modes — the one decision a user must understand. */}
      <section id="execution-modes" className="border-t border-border py-24 sm:py-28">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }} className="mb-12 text-center">
            <h2 className="text-3xl font-semibold tracking-tighter text-foreground sm:text-4xl">Two ways to fund an automation</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              You choose per automation. Wallet Automation keeps funds in your wallet; Reserved Funds lock them in AutomationVault. Neither mode puts your balance on a PayAI server.
            </p>
          </motion.div>

          <div className="grid gap-5 lg:grid-cols-2">
            {MODES.map((m, i) => (
              <motion.div
                key={m.name}
                initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ delay: i * 0.08, duration: 0.45, ease: "easeOut" }}
                className="flex flex-col rounded-2xl border border-border bg-panel/50 p-6 transition-all duration-200 hover:border-primary/35 sm:p-7"
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
      <DeveloperApi />
      <EcosystemIntegrations />

      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}>
          <h2 className="text-3xl font-semibold tracking-tighter text-foreground sm:text-4xl">
            Ready to try it?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Connect your wallet and describe your first action in a couple of minutes.
          </p>
          <div className="mt-8">
            <Link href="/auth" className="inline-flex rounded-lg bg-primary px-6 py-3.5 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              Launch PayAI
            </Link>
          </div>
          {/* NOT "no platform fee during beta" — the FAQ states a live 0.25%
              fee on fee-bearing transactions, and the two pages contradicting
              each other on price is not a copy nit. */}
          <p className="mt-4 text-xs text-muted-foreground">
            Non-custodial · On-chain execution · Built on Monad
          </p>
        </motion.div>
      </section>

      <SiteFooter />
    </main>
  );
}
