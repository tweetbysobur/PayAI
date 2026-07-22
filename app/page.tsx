"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  ShieldCheck, Lock, ArrowUpRight, ArrowDownLeft, Receipt,
  MessageSquare, ShieldHalf, Zap, ExternalLink,
  FileCheck2, Coins, AtSign, LayoutDashboard,
  ScrollText, Wallet as WalletIcon, Eye, Blocks, BadgeCheck,
  Rocket, BookOpen, Code2, LifeBuoy, Compass, ChevronDown, Sparkles, Repeat, Vault,
  PlayCircle, Clock, X, CheckCircle2, Users, Landmark, Building2, HandCoins, PlusCircle,
} from "lucide-react";
import { Badge } from "@/components/ui";
import { AutomationWorkflow } from "@/components/landing/AutomationWorkflow";
import { DashboardShowcase } from "@/components/landing/DashboardShowcase";
import { SendPaymentWorkflow } from "@/components/landing/SendPaymentWorkflow";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { GitHubMark, XMark } from "@/components/BrandIcons";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import pkg from "../package.json";

interface OnchainPayment { id: number; merchant: string; amount: number; riskScore: number; compliance: number; timestamp: number }
interface Onchain {
  configured: boolean;
  contracts?: { paymentExecutor: string; merchantRegistry: string; executorExplorer: string };
  stats?: { payments: number; volume: number; approved: number; rejected: number; requests: number } | null;
  payments: OnchainPayment[];
  explorerTxBase?: string;
}

const FLOW = [
  { icon: MessageSquare, title: "Say what you want to pay" },
  { icon: WalletIcon, title: "Approve it in your wallet" },
  { icon: Zap, title: "It arrives in seconds" },
];


const TECHNOLOGY = [
  { icon: Lock, title: "Your money stays yours", body: "You hold your own funds. PayAI never takes custody, and every payment needs your approval." },
  { icon: ShieldHalf, title: "Every payment is checked", body: "Before anything sends, we make sure it's going to the right place, for the right amount, within your limits." },
  { icon: Zap, title: "Arrives in seconds", body: "Payments land almost instantly, any time of day, with a receipt you can always look up." },
  { icon: Eye, title: "Nothing to hide", body: "Every payment is recorded permanently, so you can prove it happened whenever you need to." },
];

const FEATURES = [
  { icon: MessageSquare, title: "Pay by typing", body: "Just describe it, and we handle the rest." },
  { icon: Coins, title: "Send MON & USDC", body: "The coins people actually use." },
  { icon: ArrowDownLeft, title: "Swap instantly", body: "Move between MON and USDC in a tap." },
  { icon: AtSign, title: "Pay a name", body: "Use easy names, not long addresses." },
  { icon: Repeat, title: "Wallet Automations", body: "Recurring or future payments that stay in your wallet until each one runs." },
  { icon: Vault, title: "Reserved Funds", body: "Set money aside up front for guaranteed, on-time execution." },
  { icon: ScrollText, title: "Full history", body: "Every payment and insight, in one place." },
  { icon: LayoutDashboard, title: "Your dashboard", body: "Balances and activity at a glance." },
  { icon: ShieldHalf, title: "Built-in safety", body: "Every payment checked before it sends." },
  { icon: ExternalLink, title: "Always verifiable", body: "Prove any payment, anytime." },
];

const USE_CASES = [
  { icon: Users, title: "Payroll", body: "Pay a team or contributors on a fixed cycle, automatically." },
  { icon: Repeat, title: "Subscriptions", body: "Recurring dues and memberships that never miss a date." },
  { icon: Landmark, title: "Treasury", body: "Scheduled transfers and payouts from a reserved balance." },
  { icon: Rocket, title: "Launchpads", body: "Time-based distributions to the right wallets, on schedule." },
  { icon: HandCoins, title: "Personal Payments", body: "Rent, allowances, or gifts that send themselves on time." },
  { icon: Building2, title: "Business Payments", body: "Vendor and supplier payouts, automated and verifiable." },
];

const SHOWCASE = [
  { icon: PlusCircle, title: "Create & approve", body: "Set amount, recipient, and schedule. Sign once to authorize." },
  { icon: Eye, title: "PayAI monitors", body: "The engine watches the clock so you don't have to." },
  { icon: Zap, title: "Executes on time", body: "At the scheduled moment, the payment fires on Monad." },
  { icon: BadgeCheck, title: "Confirmed on-chain", body: "Settled, recorded, and receipted, every single run." },
];

const WHY_MONAD = [
  { title: "Fast settlement", body: "Payments and automations confirm in seconds, so a scheduled payout or an AI-triggered send never leaves you waiting." },
  { title: "Low fees", body: "High throughput keeps gas costs low, so frequent and recurring payments stay practical instead of a tax on convenience." },
  { title: "Built for real usage", body: "Wallet Automation and Reserved Funds depend on the same high-volume, repeatable transactions Monad is built to handle." },
];

const FAQS = [
  { q: "Who controls my money?", a: "You do. PayAI never holds your funds. You approve every payment yourself, and we never ask for your seed phrase or private keys." },
  { q: "How fast are payments?", a: "Seconds. Every payment lands almost instantly, any time of day, and you get a receipt you can look up whenever you want." },
  { q: "What can I send?", a: "You can send MON and USDC, swap between them in a tap, and pay easy-to-remember names instead of long wallet addresses." },
  { q: "Can I set up payments in advance?", a: "Yes. Choose how it runs: Wallet Automation keeps funds in your own wallet until each payment fires, or Reserved Funds sets money aside up front for guaranteed, on-time execution. Either way, PayAI never moves more than the limits you set." },
  { q: "Is it safe?", a: "Every payment is checked before it sends: the right recipient, the right amount, within your limits. Anything that looks risky is stopped." },
  { q: "Can I verify my payments?", a: "Always. Every payment is recorded permanently and publicly, so you can prove exactly what happened, anytime." },
];

/** Live previews of the real dashboard, driven entirely by the same
 *  /api/platform-stats aggregate the hero chips + Platform Status use — so every
 *  screen shows real, current numbers that agree with the rest of the page.
 *  Strictly aggregate + anonymized (counts, volume, an approval rate, recent
 *  amounts with no recipient) — never a wallet address or a specific user's
 *  history. Never fabricated. */

const GITHUB_URL = "https://github.com/tweetbysobur/PayAI";
const X_URL = "https://x.com/usepayAI";

const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Launch App", href: "/connect", icon: Rocket, internal: true },
      { label: "Documentation", href: `${GITHUB_URL}#readme`, icon: BookOpen, internal: false },
      { label: "Security", href: "/security", icon: ShieldCheck, internal: true },
      { label: "Compliance", href: "/dashboard/compliance", icon: FileCheck2, internal: true },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "GitHub", href: GITHUB_URL, icon: Code2, internal: false },
      { label: "Smart Contracts", href: `${GITHUB_URL}/tree/main/contracts`, icon: Blocks, internal: false },
      { label: "API Reference", href: `${GITHUB_URL}/tree/main/app/api`, icon: ScrollText, internal: false },
      { label: "Changelog", href: `${GITHUB_URL}/blob/main/CHANGELOG.md`, icon: Compass, internal: false },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Monad Explorer", href: MONAD_EXPLORER, icon: ExternalLink, internal: false },
      { label: "Support", href: `${GITHUB_URL}/issues`, icon: LifeBuoy, internal: false },
      { label: "Privacy Policy", href: "/privacy", icon: Lock, internal: true },
      { label: "Terms of Service", href: "/terms", icon: ScrollText, internal: true },
    ],
  },
];

// Each screen's dwell time must cover its own full stage narrative before the
// hero advances, or a workflow gets cut off mid-way (e.g. Automation has 6
// stages at 2.6s each = 15.6s — a flat 7s cycle was switching away before it
// ever reached "Transaction Confirmed"). Dashboard has no stage sequence, so
// it just gets a comfortable dwell to read the live numbers.
const HERO_SCREENS = [
  { key: "dashboard", label: "Dashboard", durationMs: 6500 },
  { key: "payment", label: "Send Payment", durationMs: 4 * 2600 + 1200 },
  { key: "automation", label: "Automation", durationMs: 6 * 2600 + 1200 },
] as const;
type HeroScreenKey = (typeof HERO_SCREENS)[number]["key"];

/** Cycles the three real product showcases, dashboard first (live numbers),
 *  then Send Payment, then the Automation lifecycle. Swap will join once its
 *  own showcase is ready. */
function HeroShowcase() {
  const [screen, setScreen] = useState<HeroScreenKey>("dashboard");
  const [inView, setInView] = useState(true);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Stop all showcase timers the moment the hero scrolls off-screen — this
  // page grew several sections longer this pass, so without this every
  // animated preview kept ticking (and repainting) the whole time a visitor
  // was reading further down, which is exactly what read as "lag" on mobile.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Each screen gets its OWN dwell time (see HERO_SCREENS) instead of one
  // flat interval, so a workflow always finishes its stage sequence before
  // the hero moves on — re-armed on every screen change.
  useEffect(() => {
    if (!inView) return;
    const order = HERO_SCREENS.map((s) => s.key);
    const current = HERO_SCREENS.find((s) => s.key === screen)!;
    const t = setTimeout(() => {
      setScreen(order[(order.indexOf(screen) + 1) % order.length]);
    }, current.durationMs);
    return () => clearTimeout(t);
  }, [inView, screen]);

  return (
    <div ref={rootRef}>
      <AnimatePresence mode="wait">
        <motion.div key={screen} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
          {screen === "dashboard" && <DashboardShowcase active={inView} />}
          {screen === "payment" && <SendPaymentWorkflow active={inView} />}
          {screen === "automation" && <AutomationWorkflow active={inView} />}
        </motion.div>
      </AnimatePresence>
      <div className="mt-1 flex justify-center">
        {HERO_SCREENS.map((s) => (
          <button
            key={s.key}
            onClick={() => setScreen(s.key)}
            aria-label={`Show ${s.label} preview`}
            aria-current={screen === s.key ? "true" : undefined}
            className="group p-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
          >
            <span className={`block h-1.5 w-6 rounded-full transition ${screen === s.key ? "bg-primary" : "bg-border group-hover:bg-muted-foreground/40"}`} />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [onchain, setOnchain] = useState<Onchain | null>(null);

  useEffect(() => {
    // Only real dependency the landing still needs: the live on-chain config
    // for the footer's verified smart-contract link. One fetch, no polling.
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
  }, []);

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

      {/* Navigation — product-specific, no SaaS marketing items */}
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <Logo size={32} />
          <span className="text-sm font-semibold text-foreground">PayAI</span>
        </div>
        <Link href="/connect" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
          Launch App
        </Link>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-6xl px-6 pb-10 pt-10 sm:pt-16">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr]">
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs">
              <MonadMark size={13} />
              <span className="font-medium text-foreground">MONAD</span>
            </div>
            <h1 className="text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl">
              Automate Payments on Monad.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground">
              Send, schedule, swap, and automate on-chain payments through one intelligent
              platform while keeping full control of your wallet.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/connect" className="flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
                <Sparkles size={15} /> Launch App
              </Link>
              <a href="#showcase" className="flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition hover:border-muted-foreground/30 hover:bg-input">
                <PlayCircle size={15} /> Watch Demo
              </a>
            </div>
            <div className="mt-8 grid max-w-md grid-cols-2 gap-x-5 gap-y-2.5 text-xs text-foreground">
              {[
                { icon: MonadMark, label: "Built on Monad Mainnet", brand: true },
                { icon: Lock, label: "Non-custodial" },
                { icon: ShieldHalf, label: "Secure Automation" },
                { icon: BadgeCheck, label: "Real On-chain Settlement" },
              ].map((b) => (
                <span key={b.label} className="flex items-center gap-1.5">
                  {b.brand ? <MonadMark size={13} /> : <b.icon size={13} className="text-primary" />} {b.label}
                </span>
              ))}
            </div>
          </motion.div>

          {/* Live product showcase — real flows, not mock illustrations. Starts
              on the live dashboard (real numbers), then cycles through the
              actual Send Payment and Automation lifecycles. */}
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
          >
            <HeroShowcase />
          </motion.div>
        </div>
      </section>

      {/* Why PayAI — manual vs automated */}
      <section id="why" className="mx-auto max-w-6xl px-6 py-20">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">Why PayAI</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">Stop signing the same payments by hand. Set them once and let PayAI handle the rest.</p>
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
            <p className="mb-4 flex items-center gap-2 text-sm font-semibold text-primary"><Sparkles size={15} /> With PayAI automation</p>
            <ul className="space-y-3">
              {["Set the schedule once, approve once", "Payments fire on time, on their own", "Runs whether you're online or not", "Every payment recorded and verifiable", "Full control: pause, edit, or cancel anytime"].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-foreground"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-primary" /> {t}</li>
              ))}
            </ul>
          </motion.div>
        </div>
      </section>

      {/* Real Use Cases */}
      <section id="use-cases" className="border-t border-border bg-panel/30 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">Built for real on-chain payments</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">One automation engine, many ways to use it.</p>
          </motion.div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {USE_CASES.map((u, i) => (
              <motion.div key={u.title} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-50px" }} transition={{ delay: (i % 3) * 0.05, duration: 0.3 }} whileHover={{ y: -3 }}>
                <div className="h-full rounded-xl border border-border bg-panel p-5 transition-colors hover:border-primary/30">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary"><u.icon size={18} /></div>
                  <h3 className="text-sm font-semibold text-foreground">{u.title}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{u.body}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Automation Showcase — animated timeline */}
      <section id="showcase" className="mx-auto max-w-5xl px-6 py-20">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-12 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">How a scheduled payment runs</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">You approve once. PayAI does the rest, on time, every time, and proves it on-chain.</p>
        </motion.div>
        <div className="relative grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="absolute left-0 right-0 top-6 hidden h-px bg-border lg:block" />
          {SHOWCASE.map((s, i) => (
            <motion.div key={s.title} initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-40px" }} transition={{ delay: i * 0.1, duration: 0.35 }} className="relative z-10 flex flex-col items-center text-center">
              <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-primary/40 bg-panel text-primary"><s.icon size={20} /></span>
              <span className="text-[11px] font-medium uppercase tracking-wide text-primary">Step {i + 1}</span>
              <p className="mt-1 text-sm font-semibold text-foreground">{s.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Technology */}
      <section className="border-t border-border bg-panel/30 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">Money you can trust PayAI with</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">You stay in control of your funds, every payment is checked before it sends, and everything arrives in seconds.</p>
          </motion.div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TECHNOLOGY.map((t, i) => (
              <motion.div key={t.title} initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.05, duration: 0.35 }} whileHover={{ y: -3 }}>
                <div className="h-full rounded-xl border border-border bg-panel p-5 transition-colors hover:border-primary/30">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary"><t.icon size={18} /></div>
                  <h3 className="text-sm font-semibold text-foreground">{t.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t.body}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-16">
        <motion.h2 initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center text-3xl font-semibold tracking-tight text-foreground">
          How it works
        </motion.h2>
        <div className="relative grid grid-cols-1 gap-6 sm:grid-cols-3 sm:gap-2">
          <div className="absolute left-0 right-0 top-7 hidden h-px bg-border sm:block" />
          {FLOW.map((step, i) => (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }}
              transition={{ delay: i * 0.08, duration: 0.35 }}
              className="relative z-10 flex flex-col items-center text-center"
            >
              <div className="mb-2 flex h-[56px] w-[56px] items-center justify-center rounded-full border border-border bg-panel">
                <step.icon size={20} className="text-primary" />
              </div>
              <p className="text-xs font-medium leading-snug text-foreground">{step.title}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-20">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">Everything you need to move money</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">Real features that work today. Nothing coming soon.</p>
        </motion.div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {FEATURES.map((f, i) => (
            <motion.div key={f.title} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-50px" }} transition={{ delay: (i % 5) * 0.04, duration: 0.3 }} whileHover={{ y: -3 }}>
              <div className="h-full rounded-xl border border-border bg-panel p-4 transition-colors hover:border-primary/30">
                <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary"><f.icon size={16} /></div>
                <h3 className="text-sm font-semibold text-foreground">{f.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Why PayAI is built on Monad */}
      <section id="why-monad" className="border-t border-border bg-panel/30 py-20">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2 lg:items-center">
          <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-muted-foreground">
              <MonadMark size={14} /> Built on Monad
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Why PayAI is built on Monad
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
              Automations and AI-triggered payments only feel instant if the chain underneath actually is. Monad&apos;s speed and low fees are what make that real, not a future promise.
            </p>
          </motion.div>
          <div className="space-y-6">
            {WHY_MONAD.map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, x: 12 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ delay: i * 0.08, duration: 0.35 }}
                className="border-l-2 border-primary/40 pl-5"
              >
                <h3 className="text-base font-semibold text-foreground">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl px-6 py-20">
        <motion.h2 initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-8 text-center text-3xl font-semibold tracking-tight text-foreground">
          Frequently asked questions
        </motion.h2>
        <div className="space-y-3">
          {FAQS.map((f) => <FaqItem key={f.q} q={f.q} a={f.a} />)}
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <motion.div initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}>
          <h2 className="text-4xl font-semibold tracking-tight text-foreground">
            Start moving money in seconds.
          </h2>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/connect" className="rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90">
              Launch App
            </Link>
          </div>
        </motion.div>
      </section>

      <footer className="border-t border-border bg-panel/40">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:grid-cols-5">
            {/* Brand */}
            <div className="col-span-2 sm:col-span-3 lg:col-span-2">
              <Link href="/" className="flex items-center gap-2">
                <Logo size={26} />
                <span className="text-base font-semibold text-foreground">PayAI</span>
              </Link>
              <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
                Send, swap, and automate payments with wallet confirmation. You stay in control, and money arrives in seconds.
              </p>
              <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/8 px-3 py-1.5 text-xs font-medium text-primary">
                <MonadMark size={12} /> Built on Monad Mainnet
              </div>
            </div>

            {FOOTER_COLUMNS.map((col) => (
              <div key={col.title}>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{col.title}</p>
                <ul className="mt-4 space-y-3">
                  {col.links.map((l) => {
                    const external = !l.internal;
                    const Anchor = external ? "a" : Link;
                    return (
                      <li key={l.label}>
                        <Anchor
                          href={l.href}
                          {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                          className="group flex items-center gap-2 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm"
                        >
                          <l.icon size={14} className="text-muted-foreground/60 transition-colors duration-150 group-hover:text-primary" />
                          {l.label}
                        </Anchor>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          {/* Social */}
          <div className="mt-12 flex items-center gap-3 border-t border-border pt-8">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="PayAI on GitHub"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <GitHubMark size={16} />
            </a>
            <a
              href={X_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="PayAI on X"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XMark size={15} />
            </a>
          </div>

          {/* Bottom bar */}
          <div className="mt-8 flex flex-col items-center justify-between gap-4 border-t border-border pt-6 text-xs text-muted-foreground/80 sm:flex-row">
            <p>© {new Date().getFullYear()} PayAI. All rights reserved.</p>
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
              <span className="font-mono">v{pkg.version}</span>
              <span className="hidden h-3 w-px bg-border sm:inline" />
              <span className="flex items-center gap-1.5"><MonadMark size={11} /> Powered by Monad Mainnet</span>
              <span className="hidden h-3 w-px bg-border sm:inline" />
              {onchain?.configured && onchain.contracts ? (
                <a
                  href={onchain.contracts.executorExplorer}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-success transition-colors hover:text-success/80"
                >
                  <BadgeCheck size={13} /> Contract Live on Monad
                </a>
              ) : (
                <span className="flex items-center gap-1.5 text-muted-foreground/60">
                  <BadgeCheck size={13} /> Contract status unavailable
                </span>
              )}
            </div>
          </div>
        </div>
      </footer>
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
        <ChevronDown size={16} className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180 text-primary" : ""}`} />
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
