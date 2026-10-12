"use client";

import { OPERATOR_EXAMPLES as OPERATOR_PROMPTS, displayPrompt } from "@/components/landing/intentExamples";
import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  Sparkles, ArrowLeftRight, Wallet, BarChart3, Layers, Target, BadgeCheck,
  ArrowRight, Fingerprint, Coins, CheckCircle2, Send, ShieldCheck,
  Bell, Clock, Activity, PieChart, ListChecks,
  Building2, Landmark, Repeat2, Store, Gift, Megaphone, Rocket, Home,
} from "lucide-react";
import { MonadMark } from "@/components/MonadMark";
import { TokenLogo } from "@/components/TokenLogo";
import { SignInMark, glassSignInRow } from "@/components/auth/SignInMark";

/**
 * The repositioning sections: PayAI is one natural-language intent layer,
 * not a bundle of separate products bolted together.
 *
 * Only the top-level overview belongs on the landing page. The rest of
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

/** Ask PayAI is the natural-language front door to everything else in this
 *  list — it stays out of the grid below and renders as its own dominant
 *  banner card instead, so the layout reflects the positioning rather than
 *  just the copy. */
const ASK_PAYAI = {
  icon: Sparkles,
  title: "Ask PayAI",
  body: "Tell PayAI what you want to accomplish. PayAI interprets your intent, builds the transaction flow, and lets you review before signing.",
  href: "/dashboard/ask",
  action: "Ask PayAI",
};

const PRODUCTS = [
  {
    icon: Send,
    title: "Payments",
    body: "Send payments, automate recurring transfers, distribute funds, and manage payment workflows without switching between multiple tools.",
    href: "/dashboard/payments",
    action: "See payments",
  },
  {
    icon: ArrowLeftRight,
    title: "Trading",
    body: "Trade tokens across supported Monad venues through natural-language intent, with the execution handled on-chain.",
    href: "/dashboard/ask",
    action: "Trade with Ask PayAI",
  },
  {
    icon: Layers,
    title: "DeFi",
    body: "Interact with supported DeFi protocols without manually navigating every contract, router, or transaction flow.",
    href: "/dashboard/ask",
    action: "Explore DeFi",
  },
  {
    icon: Wallet,
    title: "PayAI Wallet",
    body: "Create or connect your wallet and keep control of your assets while PayAI coordinates the actions you approve.",
    href: "/dashboard/wallets",
    action: "Manage wallets",
  },
  {
    icon: BarChart3,
    title: "Activity",
    body: "See balances, transactions, executions, and automation activity in one place with verifiable on-chain records.",
    href: "/dashboard/activity",
    action: "View activity",
  },
];

export function ProductOverviewSection() {
  return (
    <section id="platform" className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="The PayAI Experience"
          title="One Intent Layer. Multiple On-Chain Actions."
          body="Use natural-language intent to make payments, trade tokens, automate workflows, and interact with DeFi on Monad from one interface."
        />

        {/* Ask PayAI — the dominant card. Wider, elevated, glowing border:
            visually the source everything else flows from, not one tile
            among six equals. */}
        <motion.div
          initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }} transition={{ duration: 0.35 }}
          className="mb-4"
        >
          <Link
            href={ASK_PAYAI.href}
            className="group relative flex flex-col gap-5 overflow-hidden rounded-2xl border border-primary/40 bg-panel p-7 shadow-[0_1px_0_0_hsl(var(--primary)/0.25)_inset] transition-colors duration-200 hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between"
          >
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-primary/40" />
            <div className="flex items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center text-primary">
                <ASK_PAYAI.icon size={30} />
              </span>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold tracking-tight text-foreground">{ASK_PAYAI.title}</h3>
                <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">{ASK_PAYAI.body}</p>
              </div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg bg-primary px-4 py-2.5 text-xs font-medium text-primary-foreground shadow-sm shadow-primary/25 sm:self-center">
              {ASK_PAYAI.action}
              <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </span>
          </Link>
        </motion.div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PRODUCTS.map((p, i) => (
            <motion.div
              key={p.title}
              initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ delay: (i % 3) * 0.05, duration: 0.35 }}
            >
              <Link
                href={p.href}
                className="group flex h-full flex-col rounded-2xl border border-border bg-panel p-6 ring-1 ring-inset ring-white/[0.02] transition-all duration-200 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="mb-4 flex h-11 w-11 items-center justify-center text-primary">
                  <p.icon size={23} />
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
 * The execution lifecycle, one step per card, each with a small preview built
 * from the product's own UI primitives.
 *
 * These used to describe getting set up — create a wallet, fund it, build a
 * payment — which framed PayAI as a payment-automation tool you configure.
 * The stages below are the actual model instead: intent → interpretation →
 * plan → approval → execution → verification, which is the same path a
 * payment, a trade and a DeFi action all travel. Automation is one execution
 * mode inside this, not the thing being described.
 *
 * The previews show controls and stages, never figures. An invented balance
 * or recipient on the front door is the same lie whether it is in a chart or
 * a mockup, and the one thing a payments product cannot afford to be is
 * approximately honest.
 */
const STEPS: { title: string; body: string; icon: typeof Wallet; preview: React.ReactNode }[] = [
  {
    title: "Describe your intent",
    body: "Say what you want to accomplish in plain language — a payment, a trade, a schedule. No forms to map your goal onto first.",
    icon: Sparkles,
    preview: (
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-input/40 px-3 py-2">
        <Sparkles size={13} className="shrink-0 text-primary-ink" />
        <p className="truncate text-[11px] italic text-foreground">&ldquo;Swap 0.1 MON for USDC&rdquo;</p>
      </div>
    ),
  },
  {
    title: "PayAI interprets it",
    body: "The intent is resolved into structured fields — the action, the assets, the amount, and any constraints you stated.",
    icon: Target,
    preview: (
      <div className="flex flex-wrap gap-1.5">
        {["Action", "Asset", "Amount", "Constraints"].map((c) => (
          <span key={c} className="rounded-full border border-border bg-input/50 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
            {c}
          </span>
        ))}
      </div>
    ),
  },
  {
    title: "PayAI prepares the execution",
    body: "A concrete plan: the route through a supported Monad venue, the quote read live from the chain, and every step the transaction will take.",
    icon: Layers,
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
    title: "You review and approve",
    body: "The full plan is laid out before anything is signed — recipient resolved on-chain, amount checked against your balance, screened before it moves.",
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
    title: "It executes on Monad",
    body: "Your passkey or connected wallet confirms each transaction. What you approved is exactly what is submitted.",
    icon: Fingerprint,
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
    title: "The result is verified on-chain",
    body: "Every execution settles on Monad Mainnet with a transaction hash and a contract event, and the dashboard records what happened.",
    icon: BadgeCheck,
    preview: (
      <div className="flex items-center gap-2 text-[10px]">
        <span className="flex items-center gap-1 rounded-full bg-success/12 px-2 py-1 font-medium text-success">
          <CheckCircle2 size={10} /> Verified
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
          title="From intent to verified execution"
          body="Every action PayAI takes follows the same six stages — whether it is a payment, a trade, or a DeFi interaction."
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
/**
 * Each card states what PayAI does for that use case today, and what it
 * doesn't. Audited against the code (Oct 2026):
 *  - single-recipient automations: once/daily/weekly/monthly, funded from
 *    the wallet or from funds set aside (AutomationVault);
 *  - Bulk payment (Automations → Bulk payment): paste, CSV or manual list,
 *    any Monad token, equal/fixed/percentage/custom amounts, one setup
 *    signature, then ONE TRANSACTION PER RECIPIENT, sent in order from the
 *    user's wallet — not one batched on-chain transaction;
 *  - every Business, Bulk, Launchpad, DAO, NFT and Creator template is still
 *    unfinished (status in lib/automation/templates.ts).
 * test/use-case-claims.test.ts keeps the wording from drifting.
 */
type Readiness = "ready" | "partial";
const OPERATIONS: { title: string; status: Readiness; works: string; notYet?: string; icon: typeof Wallet; template?: string }[] = [
  { title: "Payroll", status: "partial", works: "Pay one person on a fixed cycle, or a whole team with a recurring Bulk payment.", notYet: "No payroll template, approver step or payslips.", icon: Building2 },
  { title: "Treasury", status: "partial", works: "Scheduled transfers from funds set aside, one recipient per automation.", notYet: "No multi-approver (multisig) control.", icon: Landmark },
  { title: "Subscriptions", status: "partial", works: "Pay a subscription or membership on a recurring schedule.", notYet: "Can't bill or collect from customers. A run is skipped if funds or limits fall short.", icon: Repeat2 },
  { title: "Vendor payments", status: "ready", works: "Pay a supplier or contractor once, or on their own recurring schedule.", icon: Store },
  { title: "Community rewards", status: "partial", works: "A Bulk payment to a pasted or CSV list of wallets, in any Monad token, set up and signed once.", notYet: "One transaction per recipient, not one batched transaction. Runs of hundreds aren't verified yet.", icon: Gift },
  { title: "Airdrops", status: "partial", works: "Send any Monad token to a list of addresses with a one-time Bulk payment, signed once.", notYet: "One transaction per recipient, not one batched transaction. Runs of hundreds aren't verified yet.", icon: Coins },
  { title: "Creator payouts", status: "partial", works: "Fixed or percentage splits to collaborators, once or recurring.", notYet: "Amounts aren't tied to your revenue — you set them.", icon: Megaphone },
  { title: "Launchpad distribution", status: "partial", works: "Send allocations to a list with a one-time Bulk payment.", notYet: "No vesting contract, token sale or refund handling.", icon: Rocket },
  { title: "Rent and personal", status: "ready", works: "Rent, allowances and savings on a weekly or monthly schedule.", icon: Home, template: "personal-monthly-rent" },
];

export function PaymentOperationsSection() {
  return (
    <section id="workflows" className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="Payments"
          title="From simple transfers to recurring payment operations."
          body="One automation engine underneath, and each card says plainly what works today and what doesn't yet."
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
                className="group flex h-full flex-col rounded-xl border border-border bg-panel p-5 transition-all duration-200 hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="mb-3 flex h-10 w-10 items-center justify-center text-primary">
                  <o.icon size={22} />
                </span>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{o.title}</h3>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${o.status === "ready" ? "border-primary/40 text-primary-ink" : "border-border text-muted-foreground"}`}>
                    {o.status === "ready" ? "Works today" : "Partly"}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-foreground/85"><strong className="font-semibold text-foreground">Works today: </strong>{o.works}</p>
                {o.notYet && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground"><strong className="font-semibold text-foreground/80">Not yet: </strong>{o.notYet}</p>}
                <span className="flex-1" />
                <span className="mt-4 inline-flex items-center gap-1 text-[11px] font-medium text-primary-ink">
                  {o.template ? "Use the workflow" : "Set it up"}
                  <ArrowRight size={11} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </Link>
            </motion.div>
          ))}
        </div>

        <p className="mt-10 text-center text-xs text-muted-foreground">
          A Bulk payment is one setup and one signature, then PayAI sends one transaction per recipient, in order. Ready-made templates for payroll, treasury, launchpad and creator payouts are still coming.
        </p>
      </div>
    </section>
  );
}

/* ── 4. AI payment operator ─────────────────────────────────────────────── */

/** Prompts Ask PayAI acts on as written — from intentExamples.ts, where each
 *  is checked against the real product. ("Pay contributors every Friday",
 *  "Create monthly payroll" and "Trade 50 USDC for any Monad token" used to
 *  rotate here; none names enough to run.) */
const OPERATOR_EXAMPLES = OPERATOR_PROMPTS.map((e) => displayPrompt(e.say));

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
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-ink">Ask PayAI</p>
          <h2 className={H2}>Say what you want. Approve what it prepares.</h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            Ask PayAI turns a sentence into a complete workflow — a payment or a trade. It resolves the recipient or
            quotes the trade live across Monad DEXs, reads the token off its own contract, checks the
            amount against your balance, and lays out every field for you to read.
          </p>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            Then it stops. Nothing is signed, sent, or scheduled until you approve it — and what you approve is exactly what
            you were shown.
          </p>
          <Link
            href="/dashboard/ask"
            className="mt-7 inline-flex items-center gap-2 rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition-all duration-200 hover:border-primary/40 hover:bg-input"
          >
            Try Ask PayAI <ArrowRight size={14} className="text-primary-ink" />
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
          className="relative order-2 overflow-hidden rounded-[22px] border border-white/10 bg-panel/55 shadow-[0_40px_100px_-42px_hsl(var(--primary)/0.7)] ring-1 ring-inset ring-white/[0.06] backdrop-blur-2xl lg:order-1"
        >
          <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
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
              <div key={s.key} className={glassSignInRow}>
                <SignInMark method={s.key} />
                <span className="truncate">{s.label}</span>
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

/* ── 6. Trading ──────────────────────────────────────────────────────────── */

/** Execution venues PayAI actually routes through today. Deliberately shown
 *  small and secondary — the user describes a trade, not a venue, and the
 *  venue PayAI picks is an implementation detail surfaced for transparency,
 *  not the headline.
 *
 *  Exported because /product renders this list in three places on one page
 *  (here, the DeFi section, and the execution row of the intent flow). Three
 *  hardcoded copies is three chances for the page to contradict itself the
 *  day a venue is added or dropped. */
export const EXECUTION_VENUES = ["Uniswap", "Kuru", "Nad.Fun"] as const;

export function TradingSection() {
  return (
    <section id="trading" className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto grid max-w-6xl gap-12 px-6 lg:grid-cols-2 lg:items-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}
        >
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-ink">Trading</p>
          <h2 className={H2}>Trade across supported Monad venues from one interface.</h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            Describe the trade in plain language. PayAI coordinates execution through supported Monad venues — quoting
            live, checking your balance, and preparing the transaction — then your own wallet signs it.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              { icon: Coins, t: "MON, USDC, and any verified Monad token" },
              { icon: BarChart3, t: "Live quotes read from the chain, not an estimate" },
              { icon: ShieldCheck, t: "Non-custodial — your wallet signs the trade" },
              { icon: PieChart, t: "Your portfolio updates as soon as it settles" },
            ].map((r) => (
              <li key={r.t} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <r.icon size={15} className="mt-0.5 shrink-0 text-primary-ink" /> {r.t}
              </li>
            ))}
          </ul>
          {/* The venue, named but kept secondary to the sentence above it. */}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Routed through:</span>
            {EXECUTION_VENUES.map((v) => (
              <span key={v} className="rounded-full border border-border bg-input/50 px-2.5 py-1 text-[11px] font-medium text-foreground">
                {v}
              </span>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45, delay: 0.1 }}
          className="overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
        >
          <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          <div className="p-6">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Trade</p>
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
                ["Venue", "Best available Monad route"],
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
          eyebrow="Your on-chain activity"
          title="See what PayAI did."
          body="Balances, executions, payments, trades and automation runs — one dashboard, scoped to your wallet, with a verifiable on-chain record behind every entry."
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
              <div className="mb-3 flex h-10 w-10 items-center justify-center text-primary">
                <a.icon size={22} />
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
