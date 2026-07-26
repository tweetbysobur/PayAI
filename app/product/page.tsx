"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight, Sparkles } from "lucide-react";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { FeatureGroupsSection, UseCasesSection } from "@/components/landing/MarketingSections";
import { TemplateShowcase } from "@/components/landing/TemplateShowcase";
import { SupportedTokens } from "@/components/landing/PlatformSections";

/**
 * /product — answers "what can PayAI actually do?"
 *
 * These four sections used to sit on the landing page, which had grown to 15
 * sections and buried the five-second pitch. They're real content a visitor
 * wants, just not at the front door: capability depth is a second-order
 * question, asked after "what is this?".
 *
 * Order is deliberate: grouped capabilities (what it does) → templates
 * (concrete starting points) → tokens (what it can move) → use cases (who
 * it's for). Each answers the question the previous one raises.
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
            Everything PayAI automates
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground">
            One automation engine, every payment shape: recurring transfers, payroll, treasury
            distributions, and bulk payouts to hundreds of wallets — in any token on Monad.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/connect" className="flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              <Sparkles size={15} /> Launch App
            </Link>
            <Link href="/how-it-works" className="flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input">
              How it works <ArrowRight size={14} className="text-primary-ink" />
            </Link>
          </div>
        </motion.div>
      </section>

      <FeatureGroupsSection />
      <TemplateShowcase />
      <SupportedTokens />
      <UseCasesSection />

      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}>
          <h2 className="text-3xl font-semibold tracking-tighter text-foreground sm:text-4xl">
            Build your first automation.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Pick a template or start from scratch, approve once, and PayAI handles every run after that.
          </p>
          <div className="mt-8">
            <Link href="/connect" className="inline-flex rounded-lg bg-primary px-6 py-3.5 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
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
