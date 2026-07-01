"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  ShieldCheck, Lock, Network, ArrowUpRight, ArrowDownLeft, Receipt,
  MessageSquare, Brain, ShieldHalf, Zap, CheckCircle2, ExternalLink,
  FileCheck2, Coins, AtSign, LayoutDashboard,
  ScrollText, Wallet as WalletIcon, Eye, Hash, Blocks, BadgeCheck,
  Rocket, BookOpen, Code2, LifeBuoy, Compass, ChevronDown, Sparkles,
} from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
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
/** Platform-wide totals across every tenant — aggregate only, no per-payment detail. */
interface PlatformActivity {
  totalPayments: number;
  volumeByToken: Record<string, number>;
}

/** "12.4 MON · 6.47 USDC" — every nonzero asset, never blended into one misleading number. */
function formatVolume(byToken: Record<string, number>): string {
  const parts = Object.entries(byToken)
    .filter(([, v]) => v > 0)
    .map(([token, v]) => `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${token}`);
  return parts.length ? parts.join(" · ") : "—";
}

const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-8)}`;

const FLOW = [
  { icon: MessageSquare, title: "Enter Payment Instruction" },
  { icon: Brain, title: "AI Understands Intent" },
  { icon: ShieldHalf, title: "Compliance Engine Runs Checks" },
  { icon: Zap, title: "Monad Executes Settlement" },
  { icon: CheckCircle2, title: "Transaction Confirmed On-Chain" },
];

type ScreenKey = "dashboard" | "transactions" | "compliance" | "wallets";
const SCREENS: { key: ScreenKey; label: string; icon: typeof LayoutDashboard; href: string }[] = [
  { key: "dashboard", label: "Payment Dashboard", icon: LayoutDashboard, href: "/dashboard" },
  { key: "transactions", label: "Transaction History", icon: ScrollText, href: "/dashboard/transactions" },
  { key: "compliance", label: "Compliance Center", icon: ShieldCheck, href: "/dashboard/compliance" },
  { key: "wallets", label: "Wallet Management", icon: WalletIcon, href: "/dashboard/wallets" },
];

const WHY = [
  { icon: Brain, title: "Natural Language Payments" },
  { icon: AtSign, title: ".nads Domain Resolution" },
  { icon: ShieldHalf, title: "Compliance First" },
  { icon: Network, title: "On-Chain Settlement" },
  { icon: Eye, title: "Real Transaction Visibility" },
];

const SECURITY = [
  { icon: FileCheck2, title: "Smart Contract Execution" },
  { icon: Lock, title: "Wallet Ownership" },
  { icon: ShieldHalf, title: "Compliance Controls" },
  { icon: ScrollText, title: "Audit Trail" },
];

const TECHNOLOGY = [
  { icon: Network, title: "Monad Mainnet", body: "Every payment settles on Monad's high-performance L1 — sub-second finality, real on-chain receipts." },
  { icon: Blocks, title: "Smart Contracts", body: "A deployed PaymentExecutor with idempotent settlement and on-chain per-tx and daily caps." },
  { icon: Brain, title: "AI Payment Engine", body: "Natural-language intent parsing turns plain English into structured, verifiable payments." },
  { icon: ShieldHalf, title: "Payment Validation", body: "PayAI Validation Engine. Every payment is validated for recipient, amount, risk, and limits before being signed." },
  { icon: Lock, title: "Wallet Security", body: "Non-custodial by design — you approve every payment in your own wallet. Keys never leave it." },
];

const FEATURES = [
  { icon: Brain, title: "AI Payments", body: "Pay in plain language." },
  { icon: Coins, title: "MON & USDC", body: "Native and stablecoin transfers." },
  { icon: ArrowDownLeft, title: "Token Swaps", body: "Swap MON ↔ USDC on-chain." },
  { icon: AtSign, title: ".nads Domains", body: "Send to human-readable names." },
  { icon: MessageSquare, title: "Scheduled Payments", body: "Recurring & future-dated." },
  { icon: ScrollText, title: "Transaction History", body: "Full, exportable audit trail." },
  { icon: LayoutDashboard, title: "Wallet Dashboard", body: "Balances, stats, insights." },
  { icon: Receipt, title: "Analytics", body: "Volume and trends over time." },
  { icon: ShieldHalf, title: "Compliance", body: "Screened on every payment." },
  { icon: ExternalLink, title: "Explorer Integration", body: "Verify every tx on Monad." },
];

const FAQS = [
  { q: "Is PayAI custodial? Who controls my funds?", a: "PayAI is non-custodial. You connect your own wallet and approve every payment yourself — your private keys never leave your wallet, and PayAI never asks for your seed phrase." },
  { q: "What network do payments settle on?", a: "Monad Mainnet (chain ID 143). Every transfer, swap, and scheduled payment is a real on-chain transaction you can verify on the Monad explorer." },
  { q: "Which assets can I send?", a: "Native MON and USDC. You can also swap between them on-chain, and send to .nads domain names which resolve to real addresses." },
  { q: "How do scheduled payments work without me signing each time?", a: "Recurring and future-dated payments settle through an authorized agent contract bounded by on-chain per-transaction and daily caps — so automated payments can never exceed limits you control." },
  { q: "How does compliance work?", a: "Before any payment is signed, PayAI's Validation Engine runs address screening, risk scoring, and travel-rule checks. Payments that fail hard checks are blocked; borderline ones are held for review." },
  { q: "Is the smart contract verified?", a: "Yes — the PaymentExecutor and registry are deployed and live on Monad Mainnet. The footer links directly to the contract on the explorer." },
];

const TRUST = [
  { icon: Network, title: "Live on Mainnet", body: "Running on Monad Mainnet — not a testnet demo." },
  { icon: BadgeCheck, title: "Smart Contract Verified", body: "Settlement contract deployed and live on-chain." },
  { icon: Brain, title: "AI Verified Intent", body: "Every instruction parsed and confirmed before signing." },
  { icon: Blocks, title: "On-Chain Settlement", body: "Real transactions, real receipts, fully traceable." },
];

/** Live previews of the real dashboard, driven by the same /api/health + /api/onchain data the dashboard itself reads — never fabricated mockups. */
function MiniScreen({ screen, health, onchain }: { screen: ScreenKey; health: Health | null; onchain: Onchain | null }) {
  const stats = onchain?.stats ?? null;
  const payments = onchain?.payments ?? [];

  if (screen === "dashboard") {
    const approvalRate = stats && stats.approved + stats.rejected > 0 ? stats.approved / (stats.approved + stats.rejected) : null;
    return (
      <div className="grid grid-cols-3 gap-3 p-5">
        {[
          { icon: ArrowUpRight, label: "Volume", value: stats ? `${stats.volume.toFixed(0)} USDC` : "—" },
          { icon: ArrowDownLeft, label: "Payments", value: stats ? `${stats.payments}` : "—" },
          { icon: Receipt, label: "Requests", value: stats ? `${stats.requests}` : "—" },
        ].map((k) => (
          <div key={k.label} className="rounded-lg border border-border bg-panel p-3">
            <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/12 text-primary"><k.icon size={13} /></div>
            <div className="text-sm font-semibold text-foreground">{k.value}</div>
            <div className="mt-1 text-[10px] text-muted-foreground">{k.label}</div>
          </div>
        ))}
        <div className="col-span-2 rounded-lg border border-border bg-panel p-3">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">Recent payments</div>
          {payments.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">No payments yet</p>
          ) : (
            <div className="flex h-16 items-end gap-1.5">
              {payments.slice(-7).map((p, i) => {
                const max = Math.max(1, ...payments.map((x) => x.amount));
                return <div key={i} className="flex-1 rounded-t bg-primary/50" style={{ height: `${Math.max(8, (p.amount / max) * 100)}%` }} />;
              })}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-panel p-3">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">Approval</div>
          {approvalRate != null ? (
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border-4 border-success/70 text-[10px] font-semibold text-foreground">
              {Math.round(approvalRate * 100)}%
            </div>
          ) : <p className="text-center text-[10px] text-muted-foreground">No data</p>}
        </div>
      </div>
    );
  }
  if (screen === "transactions") {
    // Aggregate, anonymized preview — never a specific payment's merchant
    // address. This is a public marketing page, not an audit trail; the real
    // per-payment detail (with merchant identity) lives in the authenticated
    // dashboard at /dashboard/transactions.
    return (
      <div className="space-y-2 p-5">
        <div className="grid grid-cols-3 gap-2 px-1 text-[9px] uppercase tracking-wide text-muted-foreground/70">
          <span>Asset</span><span>Amount</span><span>Status</span>
        </div>
        {payments.length === 0 ? (
          <p className="px-1 text-[11px] text-muted-foreground">No on-chain payments yet — live transactions will appear here.</p>
        ) : (
          payments.slice(-4).reverse().map((p) => (
            <div key={p.id} className="grid grid-cols-3 items-center gap-2 rounded-lg border border-border bg-panel p-3">
              <span className="text-[10px] text-muted-foreground">USDC</span>
              <span className="text-[10px] text-foreground">{p.amount.toFixed(2)}</span>
              <Badge tone={p.compliance === 1 ? "success" : "warning"}>{p.compliance === 1 ? "Approved" : "Review"}</Badge>
            </div>
          ))
        )}
      </div>
    );
  }
  if (screen === "compliance") {
    const approved = stats?.approved ?? 0;
    const rejected = stats?.rejected ?? 0;
    const rate = approved + rejected > 0 ? approved / (approved + rejected) : null;
    return (
      <div className="grid grid-cols-2 gap-3 p-5">
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-panel p-4">
          <div className="relative h-20 w-20">
            <svg width="80" height="80" viewBox="0 0 80 80" className="-rotate-90">
              <circle cx="40" cy="40" r="32" fill="none" stroke="var(--color-border)" strokeWidth="7" />
              {rate != null && (
                <circle cx="40" cy="40" r="32" fill="none" stroke="var(--color-success)" strokeWidth="7" strokeLinecap="round" strokeDasharray={2 * Math.PI * 32} strokeDashoffset={2 * Math.PI * 32 * (1 - rate)} />
              )}
            </svg>
            <div className="absolute inset-0 flex items-center justify-center"><ShieldCheck size={18} className="text-success" /></div>
          </div>
        </div>
        <div className="space-y-2 rounded-lg border border-border bg-panel p-4">
          <div className="flex items-center justify-between"><span className="text-[11px] text-muted-foreground">Approved</span><span className="text-[11px] text-foreground">{approved}</span></div>
          <div className="flex items-center justify-between"><span className="text-[11px] text-muted-foreground">Rejected</span><span className="text-[11px] text-foreground">{rejected}</span></div>
          <div className="flex items-center justify-between"><span className="text-[11px] text-muted-foreground">Requests</span><span className="text-[11px] text-foreground">{stats?.requests ?? 0}</span></div>
        </div>
      </div>
    );
  }
  // Deliberately shows network/contract status only — never an internal
  // wallet's address or balance. Every visitor here is anonymous; a wallet
  // identity (yours or PayAI's own) has no place in an unauthenticated demo.
  return (
    <div className="space-y-3 p-5">
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-2 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary"><WalletIcon size={13} /></div>
          <span className="text-[11px] text-muted-foreground">Your connected wallet appears here</span>
        </div>
        <div className="text-sm font-semibold text-foreground">Non-custodial — you sign every payment</div>
      </div>
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><MonadMark size={11} /> {health?.wallet?.network ?? "Monad"}</div>
        <Badge tone={health?.payment.connected ? "success" : "neutral"}>{health?.payment.connected ? "Live" : "Connecting…"}</Badge>
      </div>
    </div>
  );
}

const GITHUB_URL = "https://github.com/tweetbysobur/PayAI";
const X_URL = "https://x.com/tweetbysobur";

const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Launch App", href: "/connect", icon: Rocket, internal: true },
      { label: "Documentation", href: `${GITHUB_URL}#readme`, icon: BookOpen, internal: false },
      { label: "Security", href: "/dashboard/wallets", icon: ShieldCheck, internal: true },
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
  const [health, setHealth] = useState<Health | null>(null);
  const [onchain, setOnchain] = useState<Onchain | null>(null);
  const [activity, setActivity] = useState<PlatformActivity | null>(null);
  const [activeScreen, setActiveScreen] = useState<ScreenKey>("dashboard");

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
    // Platform-wide totals — covers wallet-signed sends/swaps too, not just
    // payments settled through the on-chain agent contract (onchain.stats).
    fetch("/api/platform-stats").then((r) => r.json()).then(setActivity).catch(() => {});
  }, []);

  useEffect(() => {
    const order: ScreenKey[] = ["dashboard", "transactions", "compliance", "wallets"];
    const t = setInterval(() => setActiveScreen((s) => order[(order.indexOf(s) + 1) % order.length]), 3200);
    return () => clearInterval(t);
  }, []);

  const stats = onchain?.stats ?? null;

  return (
    <main className="min-h-screen bg-background">
      {/* Navigation — product-specific, no SaaS marketing items */}
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <Logo size={32} />
          <span className="text-sm font-semibold text-foreground">PayAI</span>
        </div>
        <Link href="/connect" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          Launch App
        </Link>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pb-10 pt-10 sm:pt-16">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr]">
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs">
              <MonadMark size={13} />
              <span className="font-medium text-foreground">{health?.wallet?.network ?? "Monad"}</span>
              <span className="relative ml-0.5 flex h-1.5 w-1.5">
                {health?.payment.connected && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                )}
                <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${health?.payment.connected ? "bg-success" : "bg-muted-foreground"}`} />
              </span>
            </div>
            <h1 className="flex flex-wrap items-center gap-3 text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl">
              AI-Powered Payments on Monad <MonadMark size={40} className="inline-block translate-y-1" />
            </h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
              Send, swap, and schedule MON and USDC by simply describing what you want. Every payment is
              screened for compliance and settled on Monad Mainnet — non-custodial, verifiable, instant.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/connect" className="flex items-center gap-2 rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                <Sparkles size={15} /> Launch App
              </Link>
              <a href="#how" className="rounded-md border border-border px-5 py-3 text-sm font-medium text-foreground transition hover:bg-input">
                See how it works
              </a>
            </div>
            {/* Live platform stats — same data as Platform Status section below */}
            {activity && (activity.totalPayments > 0 || Object.values(activity.volumeByToken).some((v) => v > 0)) && (
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 rounded-lg border border-border bg-panel px-3.5 py-2 text-xs">
                  <Receipt size={12} className="text-primary" />
                  <span className="font-mono font-medium text-foreground">{activity.totalPayments.toLocaleString()}</span>
                  <span className="text-muted-foreground">payments processed</span>
                </div>
                {formatVolume(activity.volumeByToken) !== "—" && (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-panel px-3.5 py-2 text-xs">
                    <Hash size={12} className="text-primary" />
                    <span className="font-mono font-medium text-foreground">{formatVolume(activity.volumeByToken)}</span>
                    <span className="text-muted-foreground">volume</span>
                  </div>
                )}
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><Lock size={12} className="text-success" /> Non-custodial</span>
              <span className="flex items-center gap-1.5"><BadgeCheck size={12} className="text-success" /> Live on Monad Mainnet</span>
              <span className="flex items-center gap-1.5"><ShieldHalf size={12} className="text-success" /> Compliance-screened</span>
            </div>
          </motion.div>

          {/* Live device mockup */}
          <motion.div
            initial={{ opacity: 0, y: 20, rotateX: 4 }} animate={{ opacity: 1, y: 0, rotateX: 0 }}
            transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
            className="relative"
          >
            <div className="overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl">
              <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2.5">
                <span className="h-2 w-2 rounded-full bg-border" />
                <span className="h-2 w-2 rounded-full bg-border" />
                <span className="h-2 w-2 rounded-full bg-border" />
                <div className="ml-2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-2 py-0.5 text-[10px] text-muted-foreground">
                  veripayai.vercel.app/dashboard
                </div>
              </div>
              <AnimatePresence mode="wait">
                <motion.div key={activeScreen} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                  <MiniScreen screen={activeScreen} health={health} onchain={onchain} />
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="mt-3 flex justify-center gap-1.5">
              {SCREENS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setActiveScreen(s.key)}
                  aria-label={`Show ${s.label} preview`}
                  aria-current={activeScreen === s.key ? "true" : undefined}
                  className={`h-1.5 w-6 rounded-full transition ${activeScreen === s.key ? "bg-primary" : "bg-border"}`}
                />
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* Technology */}
      <section className="border-t border-border bg-panel/30 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">Built on serious infrastructure</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">PayAI combines an AI payment engine, real compliance, and on-chain settlement — no mock layers.</p>
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
        <div className="relative grid grid-cols-1 gap-6 sm:grid-cols-5 sm:gap-2">
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

      {/* Product Showcase */}
      <section id="product" className="border-t border-border bg-panel/30 py-20">
        <div className="mx-auto max-w-5xl px-6">
          <motion.h2
            initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}
            className="mb-8 text-center text-3xl font-semibold tracking-tight text-foreground"
          >
            Product
          </motion.h2>

          <div className="mb-6 flex flex-wrap justify-center gap-2">
            {SCREENS.map((s) => (
              <button
                key={s.key}
                onClick={() => setActiveScreen(s.key)}
                className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
                  activeScreen === s.key ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                <s.icon size={13} /> {s.label}
              </button>
            ))}
          </div>

          <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}>
            <Link href={SCREENS.find((s) => s.key === activeScreen)!.href} className="mx-auto block max-w-2xl overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl transition hover:border-primary/30">
              <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2.5">
                <span className="h-2 w-2 rounded-full bg-border" />
                <span className="h-2 w-2 rounded-full bg-border" />
                <span className="h-2 w-2 rounded-full bg-border" />
              </div>
              <AnimatePresence mode="wait">
                <motion.div key={activeScreen} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                  <MiniScreen screen={activeScreen} health={health} onchain={onchain} />
                </motion.div>
              </AnimatePresence>
            </Link>
          </motion.div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-20">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">Everything you need to move money</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">Only shipped, working features — each one settles real value on Monad Mainnet.</p>
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

      {/* Why PayAI */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight text-foreground">Why PayAI</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {WHY.map((w, i) => (
            <motion.div key={w.title} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.05, duration: 0.35 }} className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/12 text-primary"><w.icon size={17} /></div>
              <p className="text-xs font-medium leading-snug text-foreground">{w.title}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Security */}
      <section id="security" className="border-t border-border bg-panel/30 py-16">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight text-foreground">Security</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {SECURITY.map((s, i) => (
              <motion.div key={s.title} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.06, duration: 0.35 }} className="flex flex-col items-center gap-2 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/12 text-success"><s.icon size={17} /></div>
                <p className="text-xs font-medium leading-snug text-foreground">{s.title}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Platform Status — aggregate, platform-wide stats only. Never a
          specific payment's detail: that would mean showing a real merchant's
          wallet address on a public marketing page. Numbers are read live
          from the PaymentExecutor contract; when the suite isn't configured
          or has zero activity, that's reported truthfully rather than
          replaced with a placeholder figure. */}
      <section id="compliance" className="py-20">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight text-foreground">Platform Status</h2>
          <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}>
            <Card className="mx-auto max-w-lg">
              <div className="mb-3 flex items-center justify-between">
                <Badge tone={health?.payment.connected ? "success" : "neutral"}>{health?.payment.connected ? "Live on Mainnet" : "Connecting…"}</Badge>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><MonadMark size={11} /> {health?.wallet?.network ?? "Monad"} mainnet</span>
              </div>
              <dl className="space-y-2.5 text-sm">
                <div className="flex items-center justify-between border-b border-border pb-2.5">
                  <dt className="flex items-center gap-1.5 text-muted-foreground"><Receipt size={13} /> Total payments processed</dt>
                  <dd className="font-mono text-foreground">{activity ? activity.totalPayments.toLocaleString() : "—"}</dd>
                </div>
                <div className="flex items-center justify-between border-b border-border pb-2.5">
                  <dt className="flex items-center gap-1.5 text-muted-foreground"><Hash size={13} /> Total payment volume</dt>
                  <dd className="font-mono text-foreground">{activity ? formatVolume(activity.volumeByToken) : "—"}</dd>
                </div>
                <div className="flex items-center justify-between border-b border-border pb-2.5">
                  <dt className="flex items-center gap-1.5 text-muted-foreground"><Blocks size={13} /> Contract</dt>
                  <dd className="flex items-center gap-1 font-mono text-xs text-foreground">
                    {onchain?.contracts ? short(onchain.contracts.paymentExecutor) : "Not yet deployed"}
                    {onchain?.contracts && (
                      <a href={onchain.contracts.executorExplorer} target="_blank" rel="noreferrer" className="text-primary hover:underline"><ExternalLink size={12} /></a>
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="flex items-center gap-1.5 text-muted-foreground"><BadgeCheck size={13} /> Compliance status</dt>
                  <dd><Badge tone={health?.payment.connected ? "success" : "neutral"}>{health?.payment.connected ? "Live" : "Connecting…"}</Badge></dd>
                </div>
              </dl>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* Trust signals — real, not testimonials */}
      <section className="border-t border-border bg-panel/30 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">Trust the chain, not the claim</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground">No paid reviews. Just verifiable on-chain facts.</p>
          </motion.div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {TRUST.map((t, i) => (
              <motion.div key={t.title} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-50px" }} transition={{ delay: i * 0.05, duration: 0.35 }}>
                <div className="flex h-full flex-col items-center rounded-xl border border-border bg-panel p-5 text-center">
                  <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-success/12 text-success"><t.icon size={19} /></div>
                  <h3 className="text-sm font-semibold text-foreground">{t.title}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t.body}</p>
                </div>
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
            Start Sending Payments with AI
          </h2>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link href="/connect" className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:opacity-90">
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
                AI-powered payments with real-time compliance and on-chain settlement, built for Monad.
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
