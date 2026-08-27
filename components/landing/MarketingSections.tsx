"use client";

import { motion } from "motion/react";
import {
  Users, Repeat, Landmark, Rocket, HandCoins, Building2,
  Lock, ShieldHalf, Zap, Eye, Undo2, LifeBuoy, Wallet,
  Coins, Vault, CalendarClock, Fingerprint, PlusCircle, BadgeCheck,
  CheckCircle2, Code2, ScrollText,
} from "lucide-react";
import { MonadMark } from "@/components/MonadMark";

/**
 * Marketing sections extracted out of app/page.tsx so they can live on
 * /product and /how-it-works.
 *
 * The landing page had grown to 15 sections and ~690 lines, which buried the
 * five-second pitch under everything else. These are the sections that answer
 * a SECOND-order question ("what exactly can it do", "how does it work
 * mechanically") — real questions, but not ones the front door should be
 * answering. The landing page keeps only the pitch and the proof.
 *
 * Each export is a complete <section>, so a page composes them in order and
 * owns nothing but the arrangement.
 */

const H2 = "text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground";
const SUB = "mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground";

/* ── Use cases ──────────────────────────────────────────────────────────── */

const USE_CASES = [
  { icon: Users, title: "Payroll", body: "Pay a team or contributors on a fixed cycle, automatically." },
  { icon: Repeat, title: "Subscriptions", body: "Recurring dues and memberships that never miss a date." },
  { icon: Landmark, title: "Treasury", body: "Scheduled transfers and payouts from a reserved balance." },
  { icon: Rocket, title: "Launchpads", body: "Time-based distributions to the right wallets, on schedule." },
  { icon: HandCoins, title: "Personal Payments", body: "Rent, allowances, or gifts that send themselves on time." },
  { icon: Building2, title: "Business Payments", body: "Vendor and supplier payouts, automated and verifiable." },
];

export function UseCasesSection() {
  return (
    <section id="use-cases" className="border-t border-border bg-panel/30 py-24 sm:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
          <h2 className={H2}>Built for real on-chain payments</h2>
          <p className={SUB}>One automation engine, many ways to use it.</p>
        </motion.div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {USE_CASES.map((u, i) => (
            <motion.div key={u.title} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-50px" }} transition={{ delay: (i % 3) * 0.05, duration: 0.3 }} whileHover={{ y: -3 }}>
              <div className="h-full rounded-xl border border-border bg-panel p-5 transition-colors hover:border-primary/30">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><u.icon size={18} /></div>
                <h3 className="text-sm font-semibold text-foreground">{u.title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{u.body}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Feature groups ─────────────────────────────────────────────────────── */

const FEATURE_GROUPS = [
  {
    label: "Automation",
    icon: Repeat,
    items: [
      { title: "Wallet Automation", body: "Recurring and scheduled payments that keep funds in your wallet until each run fires." },
      { title: "Reserved Funds", body: "Set money aside up front so a payment is guaranteed to execute on time." },
      { title: "Bulk Payments", body: "Pay hundreds of recipients from one automation, with per-recipient results." },
      { title: "Templates", body: "Start from payroll, rent, treasury, or a dozen other ready-made automations." },
    ],
  },
  {
    label: "Payments",
    icon: Coins,
    items: [
      { title: "Any Monad token", body: "MON or any fungible token on Monad. Decimals read from the contract, never assumed." },
      { title: "Pay a name", body: "Send to a .nad name instead of a 42-character address." },
      { title: "Swap instantly", body: "Move between MON and USDC in a tap." },
      { title: "Pay by typing", body: "Describe the payment in plain language and review it before it sends." },
    ],
  },
  {
    label: "Security",
    icon: ShieldHalf,
    items: [
      { title: "Non-custodial", body: "PayAI never holds your funds and never asks for your keys." },
      { title: "Screened before sending", body: "Recipient, amount, and limits are checked on every single run." },
      { title: "Can't double-pay", body: "Each run carries an idempotency key enforced in the app and on-chain." },
      { title: "On-chain caps", body: "Per-transaction and daily limits are enforced by the contract, not just the app." },
    ],
  },
  {
    label: "Analytics",
    icon: ScrollText,
    items: [
      { title: "Execution history", body: "Every run with its status, amount, gas, and failure reason if any." },
      { title: "Automation health", body: "Success rate, upcoming runs, and what failed today, at a glance." },
      { title: "Always verifiable", body: "Every payment has a Monad transaction hash you can independently check." },
    ],
  },
  {
    label: "Developer",
    icon: Code2,
    items: [
      { title: "HTTP API", body: "Create and manage automations programmatically with an API key." },
      { title: "Public contracts", body: "PaymentExecutor, MerchantRegistry, and AutomationVault are verifiable on mainnet." },
      { title: "Open source", body: "The whole application, execution engine included, is on GitHub." },
    ],
  },
];

export function FeatureGroupsSection() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24 sm:py-28">
      <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
        <h2 className={H2}>What PayAI can execute today</h2>
        <p className={SUB}>Grouped by what you came here to do. Every capability below works today.</p>
      </motion.div>

      {/* One column per group. A visitor scans five labels and reads the one
          that applies to them, instead of ten equal cards. */}
      <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_GROUPS.map((g, gi) => (
          <motion.div
            key={g.label}
            initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ delay: Math.min(gi * 0.06, 0.24), duration: 0.4, ease: "easeOut" }}
          >
            <div className="mb-4 flex items-center gap-2.5 border-b border-border pb-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary-ink">
                <g.icon size={15} />
              </span>
              <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">{g.label}</h3>
            </div>
            <ul className="space-y-3.5">
              {g.items.map((it) => (
                <li key={it.title}>
                  <p className="flex items-start gap-2 text-sm font-medium tracking-tight text-foreground">
                    <CheckCircle2 size={13} className="mt-[3px] shrink-0 text-primary-ink" />
                    {it.title}
                  </p>
                  <p className="mt-0.5 pl-[21px] text-xs leading-relaxed text-muted-foreground">{it.body}</p>
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

/* ── The 7-stage automation timeline ────────────────────────────────────── */

const STAGES = [
  { icon: PlusCircle, title: "Create automation", body: "Start from a template or from scratch, and set the recipient.", phase: "setup" as const },
  { icon: Coins, title: "Choose token", body: "MON or any fungible Monad token. Decimals read from the contract.", phase: "setup" as const },
  { icon: Vault, title: "Choose execution mode", body: "Wallet Automation keeps funds in your wallet; Reserved Funds sets them aside.", phase: "setup" as const },
  { icon: CalendarClock, title: "Schedule", body: "One-time, daily, weekly, monthly, or a custom interval, in your timezone.", phase: "setup" as const },
  { icon: Fingerprint, title: "Wallet verification", body: "You sign the exact terms once. PayAI can never exceed them.", phase: "setup" as const },
  { icon: Zap, title: "Monad execution", body: "At each scheduled moment the payment fires on Monad Mainnet.", phase: "run" as const },
  { icon: BadgeCheck, title: "Completed", body: "Settled, recorded, and receipted with a verifiable transaction hash.", phase: "run" as const },
];

export function AutomationTimelineSection() {
  return (
    <section id="showcase" className="mx-auto max-w-5xl px-6 py-24 sm:py-28">
      <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-12 text-center">
        <h2 className={H2}>Automation: one execution mode</h2>
        <p className={SUB}>When an intent repeats on a schedule, the same lifecycle runs on your behalf. You approve the terms once; PayAI executes within them and proves each run on-chain.</p>
      </motion.div>

      {/* Vertical timeline, not a 4-across row: seven steps don't fit a row
          without wrapping into an ambiguous reading order, and the sequence
          IS the content here. */}
      <ol className="relative mx-auto max-w-2xl">
        <div aria-hidden className="absolute bottom-10 left-[19px] top-3 w-px bg-gradient-to-b from-primary/40 via-border to-border" />

        {STAGES.map((s, i) => {
          const phaseStart = i === 0 || STAGES[i - 1].phase !== s.phase;
          return (
            <li key={s.title}>
              {phaseStart && (
                <motion.p
                  initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}
                  viewport={{ once: true, margin: "-40px" }} transition={{ duration: 0.35 }}
                  className={`relative z-10 ml-[52px] text-[10px] font-semibold uppercase tracking-wider text-muted-foreground ${i === 0 ? "mb-3" : "mb-3 mt-7"}`}
                >
                  {s.phase === "setup" ? "One-time setup" : "Repeats on every run"}
                </motion.p>
              )}
              <motion.div
                initial={{ opacity: 0, x: -8 }} whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ delay: Math.min(i * 0.06, 0.3), duration: 0.4, ease: "easeOut" }}
                className="group relative flex gap-4 pb-7 last:pb-0"
              >
                <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-background text-primary-ink transition-colors duration-200 group-hover:border-primary/60">
                  <s.icon size={17} />
                </span>
                <div className="min-w-0 pt-1.5">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold tracking-tight text-foreground">
                    {s.title}
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Step {i + 1}</span>
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.body}</p>
                </div>
              </motion.div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ── Security ───────────────────────────────────────────────────────────── */

const TECHNOLOGY = [
  { icon: Lock, title: "Your money stays yours", body: "You hold your own funds. PayAI never takes custody, and every payment needs your approval." },
  { icon: Fingerprint, title: "Confirmation before execution", body: "Nothing signs itself. A PayAI wallet asks for your passkey on every transaction; a connected wallet asks you to sign. What you approve is what you were shown." },
  { icon: Wallet, title: "Your wallet, or ours", body: "Create a PayAI wallet from a passkey — no seed phrase, because there is nothing for us to hold — or connect the wallet you already use. Link both to one account." },
  { icon: ShieldHalf, title: "Every payment is checked", body: "Before anything sends, we make sure it's going to the right place, for the right amount, within your limits." },
  { icon: Undo2, title: "Cancelled means refunded", body: "Cancel an automation backed by Reserved Funds and what was set aside is released back to you automatically — the same when a schedule finishes its last run." },
  { icon: Zap, title: "Arrives in seconds", body: "Payments land almost instantly, any time of day, with a receipt you can always look up." },
  { icon: Eye, title: "Nothing to hide", body: "Every payment is recorded permanently, so you can prove it happened whenever you need to." },
  { icon: LifeBuoy, title: "Something wrong? Report it", body: "Report an issue on any transaction from the dashboard, and the Support Center tracks it — with your history beside it rather than in a separate inbox." },
];

export function SecuritySection() {
  return (
    <section id="security" className="border-t border-border bg-panel/30 py-24 sm:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-10 text-center">
          <h2 className={H2}>Built for money you cannot afford to lose</h2>
          <p className={SUB}>Funds never leave your control. Every payment is screened before it sends and approved by you, every run settles on Monad Mainnet with a receipt you can verify, and anything set aside comes back if you cancel.</p>
        </motion.div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TECHNOLOGY.map((t, i) => (
            <motion.div key={t.title} initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.05, duration: 0.35 }} whileHover={{ y: -3 }}>
              <div className="h-full rounded-xl border border-border bg-panel p-5 transition-colors hover:border-primary/30">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><t.icon size={18} /></div>
                <h3 className="text-sm font-semibold text-foreground">{t.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t.body}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Why Monad ──────────────────────────────────────────────────────────── */

const WHY_MONAD = [
  { title: "Fast settlement", body: "Payments and automations confirm in seconds, so a scheduled payout or an AI-triggered send never leaves you waiting." },
  { title: "Low fees", body: "High throughput keeps gas costs low, so frequent and recurring payments stay practical instead of a tax on convenience." },
  { title: "Built for real usage", body: "Wallet Automation and Reserved Funds depend on the same high-volume, repeatable transactions Monad is built to handle." },
];

export function WhyMonadSection() {
  return (
    <section id="why-monad" className="border-t border-border bg-panel/30 py-24 sm:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2 lg:items-center">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-muted-foreground">
            <MonadMark size={14} /> Built on Monad
          </div>
          <h2 className={H2}>Why PayAI is built on Monad</h2>
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
  );
}
