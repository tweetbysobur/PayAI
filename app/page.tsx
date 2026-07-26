"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  Zap, Wallet as WalletIcon, ChevronDown, Sparkles, Vault,
  Clock, X, CheckCircle2, Users,
} from "lucide-react";
import { ProductShowcase } from "@/components/landing/ProductShowcase";
import { PlatformStatistics } from "@/components/landing/PlatformSections";
import { SiteNav } from "@/components/landing/SiteNav";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { MonadMark } from "@/components/MonadMark";

/** Answers are kept strictly to what the product does TODAY — including
 *  where it has limits (Reserved Funds not supporting bulk, fees being free
 *  only during beta). An FAQ that oversells is the fastest way to lose the
 *  trust the rest of the page is trying to earn. */
const FAQS = [
  { q: "Who controls my money?", a: "You do. PayAI is non-custodial — it never holds your funds and never asks for your seed phrase or private keys. Every automation is authorized by a signature from your own wallet, and it can only ever move within the limits you set." },
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
              Automate Every Payment on Monad.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground">
              Create intelligent payment workflows that execute automatically. Schedule transfers,
              run payroll, distribute rewards, automate treasury operations, and manage recurring
              payments while keeping full control of your wallet.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/connect" className="flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
                <Sparkles size={15} /> Launch App
              </Link>
            </div>
            <div className="mt-8 grid max-w-md grid-cols-2 gap-x-5 gap-y-2.5 text-xs text-foreground">
              {[
                { icon: WalletIcon, label: "Wallet Automation" },
                { icon: Vault, label: "Reserved Funds" },
                { icon: Users, label: "Bulk Payments" },
                { icon: Zap, label: "Real-time Execution" },
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

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl px-6 py-24 sm:py-28">
        <motion.h2 initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-8 text-center text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground">
          Frequently asked questions
        </motion.h2>
        <div className="space-y-3">
          {FAQS.map((f) => <FaqItem key={f.q} q={f.q} a={f.a} />)}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}>
          {/* "Start moving money in seconds" sold speed — the thing PayAI is
              NOT differentiated on. The close should name the product's actual
              job, and the button should describe the next action rather than
              repeating the nav's generic "Launch App". */}
          <h2 className="text-4xl font-semibold tracking-tighter text-foreground sm:text-5xl">
            Build your first automation.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Connect your wallet, pick a template or start from scratch, and approve once. PayAI handles every run after that.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/connect" className="rounded-lg bg-primary px-6 py-3.5 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
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