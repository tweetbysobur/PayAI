"use client";

import { useEffect, useState } from "react";
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
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { VolumeInline, TokenLogo } from "@/components/TokenLogo";
import { GitHubMark, XMark } from "@/components/BrandIcons";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import pkg from "../package.json";

interface Health {
  payment: { connected: boolean; engine: string };
  // /api/health intentionally exposes only network/config status here, never
  // an internal wallet's address or balance (see /api/health/route.ts).
  wallet: { configured: boolean; network: string; chainId: number } | null;
}
interface OnchainPayment { id: number; merchant: string; amount: number; riskScore: number; compliance: number; timestamp: number }
interface Onchain {
  configured: boolean;
  contracts?: { paymentExecutor: string; merchantRegistry: string; executorExplorer: string };
  stats?: { payments: number; volume: number; approved: number; rejected: number; requests: number } | null;
  payments: OnchainPayment[];
  explorerTxBase?: string;
}
/** Platform-wide totals across every tenant — aggregate + anonymized only. */
interface PlatformActivity {
  totalPayments: number;
  volumeByToken: Record<string, number>;
  compliance: { approved: number; rejected: number; review: number; blocked: number; approvalRate: number };
  trend: { date: string; revenue: number; count: number }[];
  recent: { token: string; amount: number }[];
}


const FLOW = [
  { icon: MessageSquare, title: "Say what you want to pay" },
  { icon: WalletIcon, title: "Approve it in your wallet" },
  { icon: Zap, title: "It arrives in seconds" },
];

type ScreenKey = "dashboard" | "automations" | "transactions" | "compliance" | "wallets";
const SCREENS: { key: ScreenKey; label: string; icon: typeof LayoutDashboard; href: string }[] = [
  { key: "dashboard", label: "Payment Dashboard", icon: LayoutDashboard, href: "/dashboard" },
  { key: "automations", label: "Payment Automations", icon: Repeat, href: "/dashboard/automations" },
  { key: "transactions", label: "Transaction History", icon: ScrollText, href: "/dashboard/transactions" },
  { key: "compliance", label: "Payment checks", icon: ShieldCheck, href: "/dashboard/compliance" },
  { key: "wallets", label: "Wallet Management", icon: WalletIcon, href: "/dashboard/wallets" },
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
function MiniScreen({ screen, health, activity }: { screen: ScreenKey; health: Health | null; onchain: Onchain | null; activity: PlatformActivity | null }) {
  const hasVolume = activity && Object.values(activity.volumeByToken).some((v) => v > 0);
  const approvalPct = activity ? Math.round(activity.compliance.approvalRate * 100) : null;

  if (screen === "dashboard") {
    const trend = activity?.trend ?? [];
    const maxRev = Math.max(1, ...trend.map((t) => t.revenue));
    return (
      <div className="space-y-3 p-5">
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: ArrowUpRight, label: "Volume", value: hasVolume ? <VolumeInline byToken={activity!.volumeByToken} size={11} /> : "—" },
            { icon: Receipt, label: "Payments", value: activity ? activity.totalPayments.toLocaleString() : "—" },
            { icon: ShieldCheck, label: "Approval", value: approvalPct != null ? `${approvalPct}%` : "—" },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border border-border bg-panel p-3">
              <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary"><k.icon size={13} /></div>
              <div className="text-xs font-semibold leading-tight text-foreground">{k.value}</div>
              <div className="mt-1 text-[10px] text-muted-foreground">{k.label}</div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-border bg-panel p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Payment volume · 7d</span>
            <span className="flex items-center gap-1 text-[10px] text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" /> live</span>
          </div>
          <div className="flex h-20 items-end gap-1.5">
            {(trend.length ? trend : Array.from({ length: 7 }, () => ({ date: "", revenue: 0 }))).map((t, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-gradient-to-t from-primary/40 to-primary" style={{ height: `${Math.max(4, (t.revenue / maxRev) * 64)}px` }} />
                <span className="text-[8px] text-muted-foreground/60">{t.date ? t.date.slice(5) : ""}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (screen === "automations") {
    // Feature preview, not per-user data — no automation is scoped to the
    // landing page's anonymous visitor, so this illustrates the real choice
    // (Wallet Automation vs Reserved Funds) rather than fabricating a schedule.
    return (
      <div className="space-y-3 p-5">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-3.5">
            <div className="mb-2 flex items-center gap-1.5"><Repeat size={13} className="text-primary" /><span className="text-[11px] font-semibold text-foreground">Wallet Automation</span></div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">Funds stay in your wallet until each payment runs.</p>
          </div>
          <div className="rounded-xl border border-border bg-panel p-3.5">
            <div className="mb-2 flex items-center gap-1.5"><Vault size={13} className="text-primary" /><span className="text-[11px] font-semibold text-foreground">Reserved Funds</span></div>
            <p className="text-[10px] leading-relaxed text-muted-foreground">Set money aside up front for guaranteed execution.</p>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-panel p-3.5">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">Next execution</p>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/12 text-primary"><Repeat size={13} /></span>
              <div><p className="text-xs font-medium text-foreground">Weekly payment</p><p className="text-[10px] text-muted-foreground">Every Monday, 9:00 AM</p></div>
            </div>
            <Badge tone="success">Active</Badge>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "transactions") {
    // Recent settled payments — real token + amount, anonymized (no recipient,
    // sender, or hash). The full, per-user detail lives in the signed-in app.
    const recent = activity?.recent ?? [];
    return (
      <div className="space-y-2 p-5">
        <div className="grid grid-cols-[1.2fr_1fr_0.8fr] gap-2 px-1 text-[9px] uppercase tracking-wide text-muted-foreground/70">
          <span>Asset</span><span>Amount</span><span className="text-right">Status</span>
        </div>
        {recent.length === 0 ? (
          <p className="px-1 text-[11px] text-muted-foreground">Live payments appear here as they settle.</p>
        ) : (
          recent.slice(0, 5).map((p, i) => (
            <div key={i} className="grid grid-cols-[1.2fr_1fr_0.8fr] items-center gap-2 rounded-xl border border-border bg-panel px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-[11px] text-foreground"><TokenLogo token={p.token} size={14} /> {p.token}</span>
              <span className="font-mono text-[11px] text-foreground">{p.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              <span className="flex justify-end"><Badge tone="success">Settled</Badge></span>
            </div>
          ))
        )}
      </div>
    );
  }

  if (screen === "compliance") {
    const c = activity?.compliance;
    const rate = c ? c.approvalRate : 0;
    const rows = [
      { label: "Approved", value: c?.approved ?? 0, tone: "text-success" },
      { label: "Needs review", value: c?.review ?? 0, tone: "text-warning" },
      { label: "Rejected", value: (c?.rejected ?? 0) + (c?.blocked ?? 0), tone: "text-danger" },
    ];
    return (
      <div className="grid grid-cols-2 gap-3 p-5">
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-panel p-4">
          <div className="relative h-24 w-24">
            <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
              <circle cx="48" cy="48" r="38" fill="none" stroke="var(--color-border)" strokeWidth="8" />
              <circle cx="48" cy="48" r="38" fill="none" stroke="var(--color-success)" strokeWidth="8" strokeLinecap="round" strokeDasharray={2 * Math.PI * 38} strokeDashoffset={2 * Math.PI * 38 * (1 - rate)} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <ShieldCheck size={16} className="mb-0.5 text-success" />
              <span className="text-sm font-semibold text-foreground">{approvalPct ?? 0}%</span>
            </div>
          </div>
          <span className="mt-2 text-[10px] text-muted-foreground">Approval rate</span>
        </div>
        <div className="flex flex-col justify-center gap-2.5 rounded-xl border border-border bg-panel p-4">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">{r.label}</span>
              <span className={`text-sm font-semibold ${r.tone}`}>{r.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Wallets — a feature highlight (a user's real wallet is private and never
  // shown here), dressed with the live network + real platform reach.
  return (
    <div className="space-y-3 p-5">
      <div className="rounded-xl border border-border bg-gradient-to-br from-primary/[0.08] to-transparent p-4">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-primary"><WalletIcon size={15} /></div>
          <div>
            <p className="text-[11px] font-medium text-foreground">Your wallet, your keys</p>
            <p className="text-[10px] text-muted-foreground">Non-custodial. You sign every payment.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 rounded-full border border-border bg-panel px-2 py-1 text-[10px] text-foreground"><Lock size={10} className="text-success" /> Keys never leave</span>
          <span className="flex items-center gap-1 rounded-full border border-border bg-panel px-2 py-1 text-[10px] text-foreground"><MonadMark size={10} /> {health?.wallet?.network ?? "Monad"}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border bg-panel p-3">
          <div className="text-sm font-semibold text-foreground">{activity ? activity.totalPayments.toLocaleString() : "—"}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">Payments settled</div>
        </div>
        <div className="rounded-xl border border-border bg-panel p-3">
          <Badge tone={health?.payment.connected ? "success" : "neutral"}>{health?.payment.connected ? "Live on Mainnet" : "Connecting…"}</Badge>
          <div className="mt-1.5 text-[10px] text-muted-foreground">Settlement network</div>
        </div>
      </div>
    </div>
  );
}

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
              <span className="font-medium text-foreground">The payment automation platform for Monad</span>
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

          {/* Live automation workflow — real product flow, not a mock illustration */}
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
          >
            <AutomationWorkflow />
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
