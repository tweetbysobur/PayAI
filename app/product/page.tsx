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
import { WhyMonadSection } from "@/components/landing/MarketingSections";

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
          site rather than a marketing page bolted onto a product: a single
          hairline rule at the hero's optical center, not a blurred glow
          blob — that reads as the default AI-landing-page backdrop
          regardless of hue. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 flex justify-center">
        <div className="h-64 w-px bg-gradient-to-b from-primary/25 to-transparent" />
      </div>

      <SiteNav />

      <section className="relative z-10 mx-auto max-w-4xl px-6 pb-4 pt-12 text-center sm:pt-16">
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary-ink">Product</p>
          {/* "on-chain" is nowrap for the same reason as the landing hero: a
              hyphen is a legal break opportunity, and measured at 375px this
              headline splits to "Turn intent into on-" / "chain execution."
              without it. Forbidding the break is stable across every width;
              picking a font size that happens to avoid it is not (36px is
              clean at 320px and broken at 375px). */}
          <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tighter text-foreground sm:text-5xl">
            Turn intent into <span className="whitespace-nowrap">on-chain</span> execution.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground">
            PayAI is an AI-native on-chain operator on Monad. Describe what you want to accomplish, review the
            execution, and approve it from one interface.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/auth" className="flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              <Sparkles size={15} /> Launch PayAI
            </Link>
            <Link href="/how-it-works" className="flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition-all duration-200 hover:border-primary/40 hover:bg-input">
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
      {/* Why we chose Monad — toward the end, once the reader knows what PayAI does. */}
      <WhyMonadSection />

      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}>
          <h2 className="font-montserrat text-3xl font-semibold uppercase tracking-tighter text-foreground sm:text-4xl">
            Describe it. Review it. Approve it.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Payments, trading and protocols from one natural-language interface on Monad.
          </p>
          <div className="mt-8">
            <Link href="/auth" className="inline-flex rounded-lg bg-primary px-6 py-3.5 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              Launch PayAI
            </Link>
          </div>
          {/* NOT "no platform fee during beta" — the FAQ states a live 0.25%
              fee on fee-bearing transactions, and a pricing claim that
              contradicts it on another page is the kind of thing a visitor
              deciding whether to trust us with money is entitled to have
              right. */}
          <p className="mt-4 text-xs text-muted-foreground">
            Non-custodial · On-chain execution · Built on Monad
          </p>
        </motion.div>
      </section>

      <SiteFooter />
    </main>
  );
}
