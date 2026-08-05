"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  Sparkles, Repeat, ArrowLeftRight, Users, Wallet, BarChart3,
  ArrowRight, Fingerprint, Coins, CheckCircle2, Send, ShieldCheck,
  Mail, Bell, Clock, Activity, PieChart, ListChecks,
  Building2, Landmark, Repeat2, Store, Gift, Megaphone, Rocket, Home,
} from "lucide-react";
import { MonadMark } from "@/components/MonadMark";
import { TokenLogo } from "@/components/TokenLogo";

/**
 * The repositioning sections: PayAI as a payment operations platform, not a
 * single automation feature.
 *
 * Only the six-product overview belongs on the landing page. The rest of
 * these are the second-order questions — how it works mechanically, what the
 * operator does, what the wallet can do — and they live on /product and
 * /how-it-works, which is where someone goes once the front door has done its
 * job. Putting all of them on the landing page buries the pitch under the
 * detail, which is the exact mistake the page was slimmed down to fix once
 * already.
 *
 * Nothing here states a capability the deployment cannot back. The sign-in
 * list is read from the deployment's own status endpoint rather than typed
 * out, because a marketing page that hardcodes it starts lying the day the
 * configuration changes — and the person it lies to is a visitor deciding
 * whether to trust it with money.
 */

const H2 = "text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground";
const SUB = "mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground";
const SECTION = "border-t border-border py-24 sm:py-28";

/** Shared section heading — centred, restrained, same rhythm as the rest. */
function Head({ title, body, eyebrow }: { title: string; body: string; eyebrow?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}
      className="mb-12 text-center"
    >
      {eyebrow && (
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-ink">{eyebrow}</p>
      )}
      <h2 className={H2}>{title}</h2>
      <p className={SUB}>{body}</p>
    </motion.div>
  );
}

/* ── 1. Product overview ────────────────────────────────────────────────── */

const PRODUCTS = [
  {
    icon: Sparkles,
    title: "AI Payment Operator",
    body: "Describe a payment in plain English. PayAI reads it, checks the recipient and the amount, and prepares the workflow — then waits for your approval before anything moves.",
    href: "/dashboard",
    action: "Open the operator",
  },
  {
    icon: Repeat,
    title: "Payment Automation",
    body: "Payroll, subscriptions, treasury transfers and anything else that repeats. Approve the schedule once; each run fires on time and records what it did.",
    href: "/dashboard/automations",
    action: "See automations",
  },
  {
    icon: ArrowLeftRight,
    title: "Smart Swaps",
    body: "Swap between MON, USDC and any verified Monad token without leaving PayAI. Quotes come from the chain, and your own wallet signs the trade.",
    href: "/dashboard",
    action: "Swap assets",
  },
  {
    icon: Users,
    title: "Bulk Distribution",
    body: "Rewards, salaries, grants and allocations to a whole list at once. Import a CSV, paste addresses, or add them by hand — every address is validated and the full allocation is shown before you sign.",
    href: "/dashboard/automations",
    action: "Build a distribution",
  },
  {
    icon: Wallet,
    title: "Embedded Wallet",
    body: "Create a PayAI wallet with a passkey in seconds, or connect a wallet you already have. Link both to one account and choose which each workflow proposes.",
    href: "/dashboard/wallets",
    action: "Manage wallets",
  },
  {
    icon: BarChart3,
    title: "Analytics & Activity",
    body: "Balances, transactions, swaps, automation runs, upcoming executions and notifications — one dashboard, scoped to your wallet and nobody else's.",
    href: "/dashboard/analytics",
    action: "View the dashboard",
  },
];

export function ProductOverviewSection() {
  return (
    <section id="platform" className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="The platform"
          title="Six products, one payment layer"
          body="Send, swap, automate, distribute and account for payments on Monad without moving between six different applications."
        />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {PRODUCTS.map((p, i) => (
            <motion.div
              key={p.title}
              initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: (i % 3) * 0.05, duration: 0.35 }}
            >
              <Link
                href={p.href}
                className="group flex h-full flex-col rounded-2xl border border-border bg-panel p-6 ring-1 ring-inset ring-white/[0.02] transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/12 text-primary-ink transition-colors group-hover:bg-primary/20">
                  <p.icon size={19} />
                </span>
                <h3 className="text-base font-semibold tracking-tight text-foreground">{p.title}</h3>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-medium text-primary-ink">
                  {p.action}
                  <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── 2. How PayAI works ─────────────────────────────────────────────────── */

/**
 * Six steps, each with a small preview built from the product's own UI
 * primitives.
 *
 * The previews show controls and stages, never figures. An invented balance
 * or recipient on the front door is the same lie whether it is in a chart or
 * a mockup, and the one thing a payments product cannot afford to be is
 * approximately honest.
 */
const STEPS: { title: string; body: string; icon: typeof Wallet; preview: React.ReactNode }[] = [
  {
    title: "Create or connect your wallet",
    body: "A PayAI wallet takes a passkey and a few seconds. Already have a wallet? Connect it and link both to the same account.",
    icon: Fingerprint,
    preview: (
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><Fingerprint size={15} /></span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">PayAI Wallet</p>
          <p className="text-[10px] text-muted-foreground">Unlocked with your passkey</p>
        </div>
      </div>
    ),
  },
  {
    title: "Fund it, or swap what you hold",
    body: "Receive to your address, or swap between MON, USDC and any verified Monad token inside PayAI.",
    icon: Coins,
    preview: (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-lg border border-border bg-input/50 px-2.5 py-1.5 text-[11px] font-medium text-foreground">
          <TokenLogo token="MON" size={13} /> MON
        </span>
        <ArrowLeftRight size={13} className="shrink-0 text-primary-ink" />
        <span className="flex items-center gap-1.5 rounded-lg border border-border bg-input/50 px-2.5 py-1.5 text-[11px] font-medium text-foreground">
          <TokenLogo token="USDC" size={13} /> USDC
        </span>
      </div>
    ),
  },
  {
    title: "Create a payment or an automation",
    body: "One transfer, a recurring schedule, or a bulk distribution to a list. Start from a workflow or from scratch.",
    icon: Send,
    preview: (
      <div className="flex flex-wrap gap-1.5">
        {["Once", "Weekly", "Monthly", "Bulk"].map((c, i) => (
          <span
            key={c}
            className={`rounded-full border px-2.5 py-1 text-[10px] font-medium ${i === 2 ? "border-primary/40 bg-primary/12 text-primary-ink" : "border-border text-muted-foreground"}`}
          >
            {c}
          </span>
        ))}
      </div>
    ),
  },
  {
    title: "Review it with the operator",
    body: "PayAI resolves the recipient, screens the payment, and shows exactly what will happen — including the address a .nad domain points to.",
    icon: ShieldCheck,
    preview: (
      <div className="space-y-1.5">
        {["Recipient resolved on-chain", "Amount and balance checked", "Screened before signing"].map((t) => (
          <p key={t} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <CheckCircle2 size={11} className="shrink-0 text-primary-ink" /> {t}
          </p>
        ))}
      </div>
    ),
  },
  {
    title: "Approve once",
    body: "One passkey confirmation, or one signature from your connected wallet. Nothing is ever signed before you see it.",
    icon: CheckCircle2,
    preview: (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground">
          <Fingerprint size={12} /> Approve
        </span>
        <span className="text-[10px] text-muted-foreground">Your key, your call</span>
      </div>
    ),
  },
  {
    title: "PayAI runs it and reports back",
    body: "Every execution settles on Monad Mainnet with a transaction hash, and the dashboard tracks each run, its status, and its receipt.",
    icon: Activity,
    preview: (
      <div className="flex items-center gap-2 text-[10px]">
        <span className="flex items-center gap-1 rounded-full bg-success/12 px-2 py-1 font-medium text-success">
          <CheckCircle2 size={10} /> Executed
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          <MonadMark size={10} /> On Monad Mainnet
        </span>
      </div>
    ),
  },
];

export function HowPayAIWorksSection() {
  return (
    <section id="how" className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="How it works"
          title="Six steps, one approval"
          body="From an empty wallet to a payment that runs itself — and a record of every run it made."
        />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <motion.div
              key={s.title}
              initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: (i % 3) * 0.05, duration: 0.35 }}
              className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-panel ring-1 ring-inset ring-white/[0.02]"
            >
              <div className="flex-1 p-6">
                <div className="mb-4 flex items-center gap-2.5">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-[11px] font-semibold tabular-nums text-primary-ink">
                    {i + 1}
                  </span>
                  <s.icon size={15} className="text-muted-foreground" />
                </div>
                <h3 className="text-sm font-semibold tracking-tight text-foreground">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
              {/* The preview sits on the card's own footer surface, so it
                  reads as product rather than decoration. */}
              <div className="border-t border-border bg-background/40 px-6 py-4">{s.preview}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── 3. Payment operations ──────────────────────────────────────────────── */

/**
 * What people actually use PayAI for.
 *
 * This deliberately does NOT enumerate the 28 automation templates with a
 * readiness badge on each. That version was accurate and unreadable: most
 * templates are still being polished, so the section became a wall of
 * not-yet labels and argued against the product harder than any competitor
 * could. It also measured the wrong thing — a curated template is a shortcut,
 * not the capability. Every operation below can be built today from the
 * automation builder or the bulk creator, template or no template.
 *
 * Where a ready-made template does exist, the card links straight to it;
 * otherwise it opens the builder. Neither case promises anything that is not
 * there when you arrive.
 */
const OPERATIONS: { title: string; body: string; icon: typeof Wallet; template?: string }[] = [
  { title: "Payroll", body: "Salaries on a fixed cycle, to one person or a whole team.", icon: Building2 },
  { title: "Treasury", body: "Scheduled transfers and payouts from a reserved balance.", icon: Landmark },
  { title: "Subscriptions", body: "Recurring dues and memberships that never miss a date.", icon: Repeat2 },
  { title: "Vendor payments", body: "Suppliers and contractors paid on their own schedule.", icon: Store },
  { title: "Community rewards", body: "Distribute a reward across many wallets in one run.", icon: Gift },
  { title: "Airdrops", body: "A one-time token distribution to a list of addresses.", icon: Coins },
  { title: "Creator payouts", body: "Revenue splits, affiliate commissions and sponsorships.", icon: Megaphone },
  { title: "Launchpad distribution", body: "Allocations and vested releases, on schedule.", icon: Rocket },
  { title: "Rent and personal", body: "Rent, allowances and savings that send themselves.", icon: Home, template: "personal-monthly-rent" },
];

export function PaymentOperationsSection() {
  return (
    <section id="workflows" className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="Payment operations"
          title="One platform. Every payment workflow."
          body="One automation engine underneath, and enough control on top of it to run payroll, a treasury, a distribution or your own rent."
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {OPERATIONS.map((o, i) => (
            <motion.div
              key={o.title}
              initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: (i % 3) * 0.05, duration: 0.35 }}
            >
              <Link
                href={o.template ? `/dashboard/automations?template=${o.template}` : "/dashboard/automations"}
                className="group flex h-full flex-col rounded-xl border border-border bg-panel p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
                  <o.icon size={18} />
                </span>
                <h3 className="text-sm font-semibold text-foreground">{o.title}</h3>
                <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted-foreground">{o.body}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-[11px] font-medium text-primary-ink">
                  {o.template ? "Use the workflow" : "Build it"}
                  <ArrowRight size={11} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </Link>
            </motion.div>
          ))}
        </div>

        <p className="mt-10 text-center text-xs text-muted-foreground">
          Ready-made workflows for the most common of these are in the app, and more are added as they are finished.
        </p>
      </div>
    </section>
  );
}

/* ── 4. AI payment operator ─────────────────────────────────────────────── */

const OPERATOR_EXAMPLES = [
  "Pay contributors every Friday.",
  "Swap 100 MON into USDC.",
  "Send 250 USDC to alice.nad.",
  "Create monthly payroll.",
];

export function AIOperatorSection() {
  const [i, setI] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % OPERATOR_EXAMPLES.length), 3200);
    return () => clearInterval(t);
  }, []);

  return (
    <section id="operator" className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto grid max-w-6xl gap-12 px-6 lg:grid-cols-2 lg:items-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}
        >
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-ink">AI payment operator</p>
          <h2 className={H2}>Say what you want. Approve what it prepares.</h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            The operator turns a sentence into a complete workflow: it resolves the recipient, reads the token off its own
            contract, checks the amount against your balance, and lays out every field for you to read.
          </p>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            Then it stops. Nothing is signed, sent, or scheduled until you approve it — and what you approve is exactly what
            you were shown.
          </p>
          <Link
            href="/dashboard"
            className="mt-7 inline-flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input"
          >
            Try the operator <ArrowRight size={14} className="text-primary-ink" />
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45, delay: 0.1 }}
          className="overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
        >
          <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          <div className="p-5">
            {/* The real command bar's own composition: prompt, then the
                prepared workflow, then an approval that has not happened. */}
            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-input/40 px-3.5 py-3">
              <Sparkles size={15} className="shrink-0 text-primary-ink" />
              <p className="min-w-0 flex-1 truncate text-sm text-foreground">{OPERATOR_EXAMPLES[i]}</p>
            </div>

            <div className="mt-3 rounded-xl border border-border bg-background/40 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Prepared workflow</p>
              <div className="mt-3 space-y-2">
                {[
                  { label: "Recipient", value: "Resolved on-chain" },
                  { label: "Amount", value: "Checked against balance" },
                  { label: "Schedule", value: "Set from your words" },
                ].map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">{r.label}</span>
                    <span className="truncate font-medium text-foreground">{r.value}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
                <span className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground">
                  <Fingerprint size={12} /> Awaiting your approval
                </span>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ── 5. Embedded wallet ─────────────────────────────────────────────────── */

type AuthMethods = { google: boolean; apple: boolean; x: boolean; email: boolean };

/**
 * Sign-in options, as this deployment actually has them configured.
 *
 * `/api/wallet-service/status` is the same source the sign-in screen reads.
 * Listing "Continue with Apple" on the landing page while the deployment has
 * no Apple credentials would send someone to a dead end they only discover
 * after choosing to trust us — so an unconfigured method is shown, plainly,
 * as not ready yet. The passkey wallet needs no server configuration at all
 * and is therefore never gated.
 */
export function EmbeddedWalletSection() {
  const [methods, setMethods] = useState<AuthMethods | null>(null);

  useEffect(() => {
    fetch("/api/wallet-service/status")
      .then((r) => r.json())
      .then((j) => setMethods(j?.authMethods ?? null))
      .catch(() => setMethods(null));
  }, []);

  const social: { key: keyof AuthMethods; label: string }[] = [
    { key: "google", label: "Continue with Google" },
    { key: "apple", label: "Continue with Apple" },
    { key: "x", label: "Continue with X" },
    { key: "email", label: "Continue with Email" },
  ];

  return (
    <section id="wallet" className={SECTION}>
      <div className="mx-auto grid max-w-6xl gap-12 px-6 lg:grid-cols-2 lg:items-center">
        <motion.div
          initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45 }}
          className="order-2 overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl lg:order-1"
        >
          <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          <div className="space-y-2.5 p-6">
            <div className="flex items-center gap-2.5 rounded-xl border border-primary/30 bg-gradient-to-b from-primary/[0.08] to-transparent px-4 py-3.5">
              <Fingerprint size={16} className="shrink-0 text-primary-ink" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Create a PayAI wallet</p>
                <p className="text-[11px] text-muted-foreground">One passkey. No seed phrase to write down or lose.</p>
              </div>
            </div>

            {/* Only methods this deployment can actually complete. A method
                that is not configured is left off rather than listed with a
                caveat: a caveat is still an offer, and the person reading it
                has to work out that the thing in front of them does nothing.
                Nothing renders until the answer arrives, so a configured
                method never flickers in late as though it were an
                afterthought. */}
            {social.filter((s) => methods?.[s.key] === true).map((s) => (
              <div
                key={s.key}
                className="flex items-center gap-2.5 rounded-xl border border-border bg-input/30 px-4 py-3"
              >
                {s.key === "email" ? <Mail size={15} className="shrink-0 text-muted-foreground" /> : <Wallet size={15} className="shrink-0 text-muted-foreground" />}
                <span className="truncate text-sm text-foreground">{s.label}</span>
              </div>
            ))}

            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-input/30 px-4 py-3">
              <Wallet size={15} className="shrink-0 text-muted-foreground" />
              <span className="text-sm text-foreground">Or connect an existing wallet</span>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}
          className="order-1 lg:order-2"
        >
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-ink">Embedded wallet</p>
          <h2 className={H2}>A wallet in seconds, or the one you already have.</h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            The PayAI wallet is created from a passkey on your own device. There is no seed phrase, because there is nothing
            for us to hold: the key is derived on your device, and every signature asks for the passkey again.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              "Link a connected wallet to the same account",
              "Name each wallet and see when it was last connected",
              "Choose which wallet payments and automations propose",
              "Move funds between your own wallets",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-primary-ink" /> {t}
              </li>
            ))}
          </ul>
          <Link
            href="/auth"
            className="mt-7 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90"
          >
            <Sparkles size={15} /> Create your wallet
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

/* ── 6. Smart swaps ─────────────────────────────────────────────────────── */

export function SmartSwapsSection() {
  return (
    <section id="swaps" className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto grid max-w-6xl gap-12 px-6 lg:grid-cols-2 lg:items-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}
        >
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-ink">Smart swaps</p>
          <h2 className={H2}>Hold the wrong asset? Fix it here.</h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            A payment due in USDC while you hold MON used to mean leaving for a DEX, swapping, coming back, and hoping the
            balance arrived in time. PayAI quotes the swap on-chain, routes it through Uniswap v3 on Monad, and your own
            wallet signs it — then the balance is simply there for the payment you were trying to make.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              { icon: Coins, t: "MON, USDC, and any verified Monad token" },
              { icon: BarChart3, t: "Live quotes read from the chain, not an estimate" },
              { icon: ShieldCheck, t: "Non-custodial — PayAI never holds the assets" },
              { icon: PieChart, t: "Your portfolio updates as soon as it settles" },
            ].map((r) => (
              <li key={r.t} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <r.icon size={15} className="mt-0.5 shrink-0 text-primary-ink" /> {r.t}
              </li>
            ))}
          </ul>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45, delay: 0.1 }}
          className="overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
        >
          <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          <div className="p-6">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Swap</p>
              <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <MonadMark size={10} /> Monad Mainnet
              </span>
            </div>

            <div className="mt-4 space-y-2">
              {[
                { token: "MON", role: "From" },
                { token: "USDC", role: "To" },
              ].map((s) => (
                <div key={s.role} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-input/40 px-4 py-3.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.role}</span>
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <TokenLogo token={s.token} size={16} /> {s.token}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-2 rounded-xl border border-border bg-background/40 p-4 text-[11px]">
              {[
                ["Route", "Uniswap v3 on Monad"],
                ["Quote", "Read live from the pool"],
                ["Signed by", "Your wallet"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-medium text-foreground">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ── 7. Analytics ───────────────────────────────────────────────────────── */

const ANALYTICS = [
  { icon: PieChart, title: "Portfolio", body: "Every asset the wallet holds, discovered from the chain rather than a fixed list." },
  { icon: Activity, title: "Automation status", body: "What is active, what is paused, and what failed — with the reason it failed." },
  { icon: BarChart3, title: "Payment volume", body: "Settled volume per token. Never blended into one number that means nothing." },
  { icon: Clock, title: "Upcoming executions", body: "What is due next, what it will draw, and from which wallet." },
  { icon: ListChecks, title: "Recent activity", body: "Payments, swaps and automation runs in one merged, filterable feed." },
  { icon: Bell, title: "Notifications", body: "Deposits, completed swaps, and failed runs surfaced as they happen." },
];

export function AnalyticsSection() {
  return (
    <section id="analytics" className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="Analytics & activity"
          title="Know what happened, and what is about to."
          body="One dashboard for balances, executions and history — scoped to your wallet, and never to anyone else's."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ANALYTICS.map((a, i) => (
            <motion.div
              key={a.title}
              initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: (i % 3) * 0.05, duration: 0.35 }}
              className="h-full rounded-xl border border-border bg-panel p-5 transition-colors hover:border-primary/30"
            >
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
                <a.icon size={18} />
              </div>
              <h3 className="text-sm font-semibold text-foreground">{a.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{a.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
