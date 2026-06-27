"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  ShieldCheck, Lock, Network, ArrowUpRight, ArrowDownLeft, Receipt,
  MessageSquare, Brain, ShieldHalf, Zap, CheckCircle2, ExternalLink,
  FileCheck2, Coins, AtSign, LayoutDashboard,
  ScrollText, Wallet as WalletIcon, Eye, Hash, Blocks, BadgeCheck,
} from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { Logo } from "@/components/Logo";
import { MonadMark } from "@/components/MonadMark";
import { MONAD_EXPLORER } from "@/lib/monad/public";

interface Health {
  verigate: { connected: boolean; mode: string };
  wallet: { address: string | null; network: string; chainId: number; nativeBalance: string | null; symbol: string } | null;
}
interface OnchainPayment { id: number; merchant: string; amount: number; riskScore: number; compliance: number; timestamp: number }
interface Onchain {
  configured: boolean;
  contracts?: { paymentExecutor: string; merchantRegistry: string; executorExplorer: string };
  stats?: { payments: number; volume: number; approved: number; rejected: number; requests: number } | null;
  payments: OnchainPayment[];
  explorerTxBase?: string;
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

const shortAddr = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");

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
    return (
      <div className="space-y-2 p-5">
        <div className="grid grid-cols-4 gap-2 px-1 text-[9px] uppercase tracking-wide text-muted-foreground/70">
          <span>Merchant</span><span>Asset</span><span>Amount</span><span>Status</span>
        </div>
        {payments.length === 0 ? (
          <p className="px-1 text-[11px] text-muted-foreground">No on-chain payments yet — live transactions will appear here.</p>
        ) : (
          payments.slice(-4).reverse().map((p) => (
            <div key={p.id} className="grid grid-cols-4 items-center gap-2 rounded-lg border border-border bg-panel p-3">
              <span className="font-mono text-[10px] text-foreground">{shortAddr(p.merchant)}</span>
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
  return (
    <div className="space-y-3 p-5">
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-2 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary"><WalletIcon size={13} /></div>
          <span className="font-mono text-[11px] text-muted-foreground">{shortAddr(health?.wallet?.address)}</span>
        </div>
        <div className="text-sm font-semibold text-foreground">{health?.wallet?.nativeBalance != null ? `${Number(health.wallet.nativeBalance).toFixed(4)} MON` : "—"}</div>
      </div>
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-2 text-[11px] text-muted-foreground">{health?.wallet?.network ?? "Monad"}</div>
        <Badge tone={health?.wallet?.address ? "success" : "neutral"}>{health?.wallet?.address ? "Live" : "Connecting…"}</Badge>
      </div>
    </div>
  );
}

const FOOTER_LINKS = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Monad", href: "https://monad.xyz" },
  { label: "Explorer", href: MONAD_EXPLORER },
];

export default function LandingPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [onchain, setOnchain] = useState<Onchain | null>(null);
  const [activeScreen, setActiveScreen] = useState<ScreenKey>("dashboard");

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
  }, []);

  useEffect(() => {
    const order: ScreenKey[] = ["dashboard", "transactions", "compliance", "wallets"];
    const t = setInterval(() => setActiveScreen((s) => order[(order.indexOf(s) + 1) % order.length]), 3200);
    return () => clearInterval(t);
  }, []);

  const latestPayment = onchain?.payments?.[onchain.payments.length - 1] ?? null;

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
            <div className="mb-5 flex items-center gap-2 text-xs">
              <span className={`h-1.5 w-1.5 rounded-full ${health?.verigate.connected ? "bg-success" : "bg-border"}`} />
              <span className="text-muted-foreground">{health?.wallet?.network ?? "Connecting…"}</span>
            </div>
            <h1 className="flex flex-wrap items-center gap-3 text-5xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl">
              AI-Powered Payments on Monad <MonadMark size={40} className="inline-block translate-y-1" />
            </h1>
            <p className="mt-5 max-w-md text-base text-muted-foreground">
              Send MON and USDC using natural language, compliance checks, and on-chain settlement.
            </p>
            <div className="mt-8 flex items-center gap-3">
              <Link href="/connect" className="rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:opacity-90">
                Launch App
              </Link>
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
                <button key={s.key} onClick={() => setActiveScreen(s.key)} className={`h-1.5 w-6 rounded-full transition ${activeScreen === s.key ? "bg-primary" : "bg-border"}`} />
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* How It Works */}
      <section className="mx-auto max-w-6xl px-6 py-16">
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

      {/* Blockchain Transparency */}
      <section id="compliance" className="py-20">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight text-foreground">Blockchain Transparency</h2>
          <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}>
            <Card className="mx-auto max-w-lg">
              <div className="mb-3 flex items-center justify-between">
                <Badge tone={latestPayment ? "success" : "neutral"}>{latestPayment ? "Settled" : "Live — awaiting first payment"}</Badge>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><MonadMark size={11} /> {health?.wallet?.network ?? "Monad"} mainnet</span>
              </div>
              {latestPayment ? (
                <dl className="space-y-2.5 text-sm">
                  <div className="flex items-center justify-between border-b border-border pb-2.5">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><Hash size={13} /> Transaction Hash</dt>
                    <dd className="font-mono text-xs text-foreground">{short(latestPayment.merchant)}</dd>
                  </div>
                  <div className="flex items-center justify-between border-b border-border pb-2.5">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><ExternalLink size={13} /> Explorer Link</dt>
                    <dd>
                      <a href={`${onchain?.explorerTxBase ?? MONAD_EXPLORER + "/tx/"}${latestPayment.id}`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">View</a>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between border-b border-border pb-2.5">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><Blocks size={13} /> Block Confirmation</dt>
                    <dd className="text-foreground">Confirmed</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><BadgeCheck size={13} /> Settlement Status</dt>
                    <dd><Badge tone={latestPayment.compliance === 1 ? "success" : "neutral"}>{latestPayment.compliance === 1 ? "Approved" : "Pending"}</Badge></dd>
                  </div>
                </dl>
              ) : (
                <dl className="space-y-2.5 text-sm">
                  <div className="flex items-center justify-between border-b border-border pb-2.5">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><Hash size={13} /> Transaction Hash</dt>
                    <dd className="text-xs text-muted-foreground">Awaiting first payment</dd>
                  </div>
                  <div className="flex items-center justify-between border-b border-border pb-2.5">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><ExternalLink size={13} /> Explorer Link</dt>
                    <dd className="flex items-center gap-1 font-mono text-xs text-foreground">
                      {onchain?.contracts ? short(onchain.contracts.paymentExecutor) : "—"}
                      {onchain?.contracts && (
                        <a href={onchain.contracts.executorExplorer} target="_blank" rel="noreferrer" className="text-primary hover:underline"><ExternalLink size={12} /></a>
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between border-b border-border pb-2.5">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><Blocks size={13} /> Block Confirmation</dt>
                    <dd className="text-xs text-muted-foreground">—</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="flex items-center gap-1.5 text-muted-foreground"><BadgeCheck size={13} /> Settlement Status</dt>
                    <dd><Badge tone={health?.verigate.connected ? "success" : "neutral"}>{health?.verigate.connected ? "Live" : "Connecting…"}</Badge></dd>
                  </div>
                </dl>
              )}
            </Card>
          </motion.div>
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

      <footer className="border-t border-border py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-6">
          <div className="flex items-center gap-2">
            <Logo size={22} />
            <span className="text-sm font-semibold text-foreground">PayAI</span>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            {FOOTER_LINKS.map((l) => (
              <a key={l.label} href={l.href} target={l.href.startsWith("http") ? "_blank" : undefined} rel={l.href.startsWith("http") ? "noreferrer" : undefined} className="hover:text-foreground">
                {l.label}
              </a>
            ))}
          </nav>
          <p className="text-center text-xs text-muted-foreground/70">
            Natural-language intent parsing · Real-time compliance checks · Settlement on Monad mainnet
          </p>
        </div>
      </footer>
    </main>
  );
}
