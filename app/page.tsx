"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  Wallet as WalletIcon, ChevronDown, Sparkles, PlayCircle,
  Clock, X, CheckCircle2, Users, Repeat, ArrowLeftRight, BarChart3,
} from "lucide-react";
import { ProductShowcase } from "@/components/landing/ProductShowcase";
import { PlatformStatistics } from "@/components/landing/PlatformSections";
import { WhyMonadSection } from "@/components/landing/MarketingSections";
import { ProductOverviewSection } from "@/components/landing/PlatformOverview";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { MonadMark } from "@/components/MonadMark";

/** Answers are kept strictly to what the product does TODAY — including
 *  where it has limits (Reserved Funds not supporting bulk, fees being free
 *  only during beta). An FAQ that oversells is the fastest way to lose the
 *  trust the rest of the page is trying to earn. */
const FAQS = [
  { q: "Who controls my money?", a: "You do. PayAI is non-custodial — it never holds your funds and never asks for your seed phrase or private keys. Every automation is authorized by a signature from your own wallet, and it can only ever move within the limits you set." },
  { q: "Can Ask PayAI trade for me, not just pay?", a: "Yes. Describe a trade in plain English and Ask PayAI quotes it live — across Uniswap, Kuru, and Nad.Fun, including tokens still on a bonding curve before they graduate to a full DEX pool — then your own wallet signs it. Uniswap and Kuru trades carry a 0.25% platform fee, taken from what you're spending and shown before you approve; Nad.Fun trades currently have no PayAI fee." },
  { q: "What is Nad.Fun / DeFi trading?", a: "Nad.Fun is Monad's bonding-curve launchpad for new tokens. Ask PayAI can buy or sell any Nad.Fun token — before or after it graduates to a full DEX pool — the same way it handles an established token: describe it, get a live quote, sign once." },
  { q: "What is Wallet Automation?", a: "Your funds stay in your wallet until each payment fires. You approve a spending allowance once, and PayAI pulls only the exact amount due at each scheduled run. Nothing is moved in advance, and you can revoke the approval at any time." },
  { q: "What is Reserved Funds?", a: "Funds are set aside up front in the AutomationVault contract, which guarantees the payment can execute even if your wallet balance changes later. The reservation is locked to the recipient you chose, so it can only ever pay them — and you can refund what's unspent." },
  { q: "Which tokens can I automate?", a: "Any fungible token on Monad, plus native MON. PayAI reads a token's symbol, name, and decimals directly from its contract rather than assuming them, so a token doesn't need to be on a list to work — paste its address and it's supported." },
  { q: "How do Bulk Payments work?", a: "Upload a CSV or Excel file, paste addresses, or add recipients manually, then split by equal, fixed, percentage, or custom amounts. PayAI validates every address, catches duplicates, and shows the full allocation before you sign. Bulk runs use Wallet Automation — Reserved Funds can't back a bulk payment, because a vault reservation is locked to a single recipient." },
  { q: "What are the fees?", a: "There is no platform fee during beta. You pay only Monad network gas, which is a fraction of a cent per payment. If a platform fee is ever introduced, it will be shown on the review screen before you approve anything." },
  { q: "Are there templates to start from?", a: "Yes — ready-made automations for payroll, contractors, vendors, subscriptions, rent, savings, treasury distributions, DAO payouts, creator revenue splits, launchpad distributions, and more. A template just pre-fills sensible defaults; every field stays editable before you activate it." },
  { q: "When exactly does a payment execute?", a: "At the time and timezone you set. A scheduler checks for due automations continuously, and each run is idempotent — enforced both in the app and on-chain — so a retry can never double-pay. If a run fails, PayAI retries with a backoff and tells you why." },
  { q: "Can I verify what happened?", a: "Always. Every execution is recorded on Monad Mainnet with a transaction hash, and the dashboard shows each run's status, amount, recipient, gas, and failure reason if any — including per-recipient results for bulk payments." },
];

/**
 * The landing page: the five-second pitch and the proof, nothing else.
 *
 * It was 15 sections and ~690 lines, which buried the pitch under capability
 * depth. Everything answering a second-order question ("what exactly can it
 * do", "how does it work mechanically") now lives on /product and
 * /how-it-works, reachable from the header nav.
 *
 * What stays: hero, the problem being solved, live platform totals as proof,
 * the FAQ, and one closing CTA. No data fetching of its own any more — the
 * footer and the stats section each own theirs.
 */
export default function LandingPage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-background">
      {/* Ambient depth — a restrained purple glow with a lighter violet hint,
          plus a faint grid. Craft, not decoration: keeps the canvas from
          reading flat/templated without competing with content. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[720px] overflow-hidden">
        {/* GPU-cheap radial glow (no filter:blur) — purple wash with a lighter violet hint. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(680px 460px at 50% -8%, hsl(var(--primary) / 0.22), transparent 70%), radial-gradient(340px 280px at 85% 18%, hsl(var(--secondary) / 0.10), transparent 72%)",
          }}
        />
        {/* Faint grid, masked to fade downward — adds craft without noise. */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, #000 40%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 0%, #000 40%, transparent 100%)",
          }}
        />
      </div>

      <SiteNav />

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-10 pt-10 sm:pt-16">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr]">
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs">
              <MonadMark size={13} />
              <span className="font-medium text-foreground">MONAD</span>
            </div>
            <h1 className="text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl">
              Turn Natural-Language Intent Into On-Chain Actions.
            </h1>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/auth" className="flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
                <Sparkles size={15} /> Launch App
              </Link>
              {/* Secondary action points at the walkthrough, not a video: there
                  is no recording to play, and a button promising one that
                  opens a text page is a promise broken on the first click.
                  Relabel it the day a demo exists. */}
              <Link href="/how-it-works" className="flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input">
                <PlayCircle size={15} className="text-primary-ink" /> See how it works
              </Link>
            </div>
            {/* The platform in six words each — what a visitor is choosing
                between products on, not a feature list of one of them. */}
            <div className="mt-8 grid max-w-md grid-cols-2 gap-x-5 gap-y-2.5 text-xs text-foreground">
              {[
                { icon: Sparkles, label: "AI Trading & Payments" },
                { icon: Repeat, label: "Payment Automation" },
                { icon: ArrowLeftRight, label: "Smart Swaps" },
                { icon: Users, label: "Bulk Distribution" },
                { icon: WalletIcon, label: "Embedded Wallet" },
                { icon: BarChart3, label: "Analytics & Activity" },
              ].map((b) => (
                <span key={b.label} className="flex items-center gap-1.5">
                  <b.icon size={13} className="text-primary-ink" /> {b.label}
                </span>
              ))}
            </div>
          </motion.div>

          {/* The real product, in the hero — cycling Automation Center →
              lifecycle → instant payment → live totals. Automation Center
              leads, so the first thing a visitor sees is a list of running
              automations rather than a wallet balance. Tabs are clickable. */}
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
          >
            <ProductShowcase />
          </motion.div>
        </div>
      </section>

      {/* What the platform is, before anything else. A visitor who reads only
          this far should already know PayAI is six products, not one.

          This is the ONLY repositioning section on the landing page. The
          operator, the swap, the wallet, the mechanics, the workflows and the
          analytics all answer a second-order question, and they live on
          /product and /how-it-works — the same split this page was slimmed
          down to once before. Each card here links into the product itself,
          and the nav carries the two deeper pages. */}
      <ProductOverviewSection />

      {/* Why PayAI — manual vs automated */}
      <section id="why" className="mx-auto max-w-6xl px-6 py-24 sm:py-28">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
          {/* Names the visitor's problem, not the product. The old "Why PayAI"
              asked them to care about us before we'd shown we understand them. */}
          <h2 className="text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground">Stop managing payments manually</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">Every recurring payment you sign by hand is a deadline you have to remember and a step that can be missed. Automation removes both.</p>
        </motion.div>
        <div className="grid gap-4 md:grid-cols-2">
          <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.35 }} className="rounded-xl border border-border bg-panel p-6">
            <p className="mb-4 flex items-center gap-2 text-sm font-semibold text-muted-foreground"><Clock size={15} /> Doing it manually</p>
            <ul className="space-y-3">
              {["Remember every due date yourself", "Sign each payment, one at a time", "Miss a payment if you're offline or busy", "No single record of what went out", "Repeat it all again next cycle"].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-muted-foreground"><X size={15} className="mt-0.5 shrink-0 text-danger/70" /> {t}</li>
              ))}
            </ul>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: 0.06, duration: 0.35 }} className="rounded-xl border border-primary/30 bg-gradient-to-b from-primary/[0.06] to-transparent p-6">
            <p className="mb-4 flex items-center gap-2 text-sm font-semibold text-primary-ink"><Sparkles size={15} /> With PayAI automation</p>
            <ul className="space-y-3">
              {["Set the schedule once, approve once", "Payments fire on time, on their own", "Runs whether you're online or not", "Every payment recorded and verifiable", "Full control: pause, edit, or cancel anytime"].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-foreground"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-primary-ink" /> {t}</li>
              ))}
            </ul>
          </motion.div>
        </div>
      </section>


      {/* Live platform totals — the proof the pitch above is real. Kept on
          the landing page deliberately: it is evidence, not capability
          depth, so it belongs at the front door. */}
      <PlatformStatistics />

      {/* Why Monad, immediately before the FAQ. Also rendered on
          /how-it-works: the chain choice is both a landing-page trust signal
          and part of the mechanical explanation, and it's a pure-presentation
          section so showing it in both places costs nothing and duplicates
          no state. */}
      <WhyMonadSection />

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl px-6 py-24 sm:py-28">
        <motion.h2 initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-8 text-center text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground">
          Frequently asked questions
        </motion.h2>
        <div className="space-y-3">
          {FAQS.map((f) => <FaqItem key={f.q} q={f.q} a={f.a} />)}
        </div>
      </section>

      {/* Final CTA. max-w-4xl, not -3xl — the -3xl column left this heading
          only 720px to work with, forcing "Start Managing Payments, Not
          Transactions." across three ragged lines once it went uppercase
          Montserrat (a wider face than the site's default). The paragraph
          under it keeps its own max-w-xl regardless, so only the heading
          gets the extra room. */}
      <section className="mx-auto max-w-4xl px-6 py-24 text-center">
        <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}>
          {/* The close names the job, not the feature. "Build your first
              automation" asked for a commitment to one product; the platform
              is what the page has just spent its length arguing for. */}
          <h2 className="font-montserrat text-4xl font-semibold uppercase tracking-tighter text-foreground sm:text-5xl">
            Start managing payments, not transactions.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Everything you need to send, trade, swap DeFi tokens, automate and manage payments on Monad — from one platform.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/auth" className="rounded-lg bg-primary px-6 py-3.5 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              Launch PayAI
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

/** Accessible FAQ accordion row — keyboard-operable, animated height. */
function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-panel">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-input/40"
      >
        <span className="text-sm font-medium text-foreground">{q}</span>
        <ChevronDown size={16} className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180 text-primary-ink" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-4 text-sm leading-relaxed text-muted-foreground">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}