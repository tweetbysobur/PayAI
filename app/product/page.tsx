"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight, Sparkles } from "lucide-react";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import {
  CoreProductSection, IntentToExecutionSection, CapabilitiesSection,
  DeFiSection, VerificationSection, IntentExamplesSection,
} from "@/components/landing/ProductSections";
import {
  TradingSection, EmbeddedWalletSection, PaymentOperationsSection, AnalyticsSection,
} from "@/components/landing/PlatformOverview";

/**
 * /product — answers "what is PayAI, and what can it actually do?"
 *
 * Repositioned around the real core product model: natural-language intent
 * → interpretation → planning → user review → wallet approval → on-chain
 * execution → verification. Payments, trading, DeFi and automation are
 * capabilities of that one intent layer, not six separate products — so the
 * page leads with the intent-to-execution model itself (CoreProduct,
 * IntentToExecution, Capabilities) before going into each capability's own
 * depth. Capability depth is still a second-order question the landing page
 * deliberately leaves out — that split hasn't changed, only what "the
 * platform" is being described as.
 */
export default function ProductPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Same ambient treatment as the landing page so the pages feel like one
          site rather than a marketing page bolted onto a product. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] overflow-hidden">
        <div className="absolute left-1/2 top-[-180px] h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-primary/10 blur-[100px]" />
      </div>

      <SiteNav />

      <section className="relative z-10 mx-auto max-w-4xl px-6 pb-4 pt-12 text-center sm:pt-16">
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-ink">Product</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tighter text-foreground sm:text-5xl">
            Turn intent into on-chain execution.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground">
            PayAI is an AI-native on-chain operator on Monad. Describe what you want to accomplish, review the
            execution, and approve it from one interface.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/auth" className="flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              <Sparkles size={15} /> Launch PayAI
            </Link>
            <Link href="/how-it-works" className="flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input">
              How it works <ArrowRight size={14} className="text-primary-ink" />
            </Link>
          </div>
        </motion.div>
      </section>

      {/* The core model first — intent, then the execution flow, then the
          capabilities it powers — before any capability's own depth. */}
      <CoreProductSection />
      <IntentToExecutionSection />
      <CapabilitiesSection />
      <EmbeddedWalletSection />
      <PaymentOperationsSection />
      <TradingSection />
      <DeFiSection />
      <VerificationSection />
      <AnalyticsSection />
      <IntentExamplesSection />

      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}>
          <h2 className="font-montserrat text-3xl font-semibold uppercase tracking-tighter text-foreground sm:text-4xl">
            Start managing payments, not transactions.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Everything you need to send, trade, swap DeFi tokens, automate and manage payments on Monad — from one platform.
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
