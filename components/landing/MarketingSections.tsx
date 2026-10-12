"use client";

import { motion } from "motion/react";
import {
  Users, Repeat, Landmark, Rocket, HandCoins, Building2,
  Lock, ShieldHalf, Zap, Eye, Undo2, LifeBuoy, Wallet,
  Coins, Fingerprint,
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
            <motion.div key={u.title} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-50px" }} transition={{ delay: (i % 3) * 0.05, duration: 0.3 }}>
              <div className="h-full rounded-xl border border-border bg-panel p-5 transition-colors hover:border-primary/30">
                <div className="mb-3 flex h-10 w-10 items-center justify-center text-primary"><u.icon size={22} /></div>
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
      { title: "Non-custodial by default", body: "Interactive payments are signed by your wallet. Automations are capped on-chain. PayAI never asks for a seed phrase." },
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
      { title: "Verified contracts", body: "PaymentExecutor, MerchantRegistry, and AutomationVault are verifiable on mainnet." },
      { title: "Idempotent by design", body: "Every execution carries a request id enforced in the app and on-chain." },
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

/* ── How an automation runs ─────────────────────────────────────────────── */

type Actor = "You" | "PayAI";
interface Stage { n: string; stage: string; what: string; who: Actor }

/** Every line here is checked against the product: funding modes
 *  (lib/platform/schedules.ts, AutomationVault), the per-run re-check
 *  (lib/automation/execute.ts runs validation and risk before each send and
 *  records a stopped run without sending), and the capped agent wallet
 *  (PaymentExecutor's on-chain per-transaction and daily caps). */
const SETUP: Stage[] = [
  { n: "01", stage: "Recipient", who: "You", what: "Choose who gets paid — a 0x address, a .nad name or a saved payee. Start in Automations, or from a request in Ask PayAI." },
  { n: "02", stage: "Token and amount", who: "You", what: "MON, USDC or another Monad token, and the amount for each run. Decimals are read from the token contract, never assumed." },
  { n: "03", stage: "Funding", who: "You", what: "Wallet Automation keeps funds in your wallet; each run draws only what is due. Reserved Funds sets the total aside in the AutomationVault contract, which can only pay that recipient or refund you." },
  { n: "04", stage: "Schedule", who: "You", what: "One-time, daily, weekly, monthly or every few days, weeks or months — in your own timezone." },
  { n: "05", stage: "Authorize", who: "You", what: "You sign the exact terms once. The agent wallet that runs it is capped per transaction and per day on-chain, so it cannot spend beyond them." },
];
const EVERY_RUN: Stage[] = [
  { n: "06", stage: "Check", who: "PayAI", what: "Recipient, amount and limits are checked again before anything is sent. A run that fails is stopped, nothing moves, and you are told why." },
  { n: "07", stage: "Execute", who: "PayAI", what: "The payment is sent on Monad from the capped agent wallet, at the scheduled time." },
  { n: "08", stage: "Record", who: "PayAI", what: "The run is recorded with its transaction hash and shows up in your History and notifications." },
];

function ActorTag({ who }: { who: Actor }) {
  return (
    <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] font-medium ${who === "You" ? "border-primary/40 text-primary-ink" : "border-border text-muted-foreground"}`}>
      {who}
    </span>
  );
}

function PhaseRows({ label, note, rows }: { label: string; note: string; rows: Stage[] }) {
  return (
    <tbody>
      <tr>
        <th colSpan={4} scope="colgroup" className="border-t border-border bg-panel/50 px-5 py-3 text-left">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-foreground">{label}</span>
          <span className="ml-3 text-xs font-normal text-muted-foreground">{note}</span>
        </th>
      </tr>
      {rows.map((r) => (
        <tr key={r.n} className="border-t border-border align-top">
          <td className="w-16 px-5 py-4 font-mono text-xs text-primary-ink">{r.n}</td>
          <th scope="row" className="w-44 px-5 py-4 text-left text-sm font-medium text-foreground">{r.stage}</th>
          <td className="px-5 py-4 text-sm leading-relaxed text-muted-foreground">{r.what}</td>
          <td className="w-24 px-5 py-4 text-right"><ActorTag who={r.who} /></td>
        </tr>
      ))}
    </tbody>
  );
}

function PhaseList({ label, note, rows }: { label: string; note: string; rows: Stage[] }) {
  return (
    <div>
      <div className="border-t border-border bg-panel/50 px-4 py-3">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      </div>
      <ol>
        {rows.map((r) => (
          <li key={r.n} className="border-t border-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground"><span className="mr-2 font-mono text-xs text-primary-ink">{r.n}</span>{r.stage}</p>
              <ActorTag who={r.who} />
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{r.what}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function AutomationTimelineSection() {
  const setupNote = "Once, when you create it";
  const runNote = "Automatically, at every scheduled time";
  return (
    <section id="automation" aria-labelledby="automation-title" className="border-t border-border">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-6 sm:py-24">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:items-end lg:gap-16">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">Automations</p>
            <h2 id="automation-title" className="mt-3 text-balance text-2xl font-medium tracking-[-0.03em] text-foreground sm:text-4xl">
              How a recurring payment runs.
            </h2>
          </div>
          <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            You set the terms and sign them once. From then on PayAI carries out each run on schedule — checking it first, never going past the limits you signed — and records every one. You can pause, edit or cancel it at any time; cancelling Reserved Funds returns what was set aside.
          </p>
        </div>

        <div className="mt-10 overflow-hidden rounded-xl border border-border">
          {/* Desktop: one table, two phases. */}
          <table className="hidden w-full border-collapse md:table">
            <caption className="sr-only">The stages of a Payment Automation, who carries out each one, and when</caption>
            <thead>
              <tr className="text-left">
                <th scope="col" className="px-5 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Step</th>
                <th scope="col" className="px-5 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Stage</th>
                <th scope="col" className="px-5 py-3 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">What happens</th>
                <th scope="col" className="px-5 py-3 text-right font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Who</th>
              </tr>
            </thead>
            <PhaseRows label="Set up once" note={setupNote} rows={SETUP} />
            <PhaseRows label="Every run" note={runNote} rows={EVERY_RUN} />
          </table>
          {/* Phone: the same rows, stacked. */}
          <div className="md:hidden">
            <div className="-mt-px">
              <PhaseList label="Set up once" note={setupNote} rows={SETUP} />
            </div>
            <PhaseList label="Every run" note={runNote} rows={EVERY_RUN} />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Security ───────────────────────────────────────────────────────────── */

const TECHNOLOGY = [
  { icon: Lock, title: "Your money stays yours", body: "Payments and trades you start are signed by your own wallet, and PayAI never holds its keys. Payment Automations are the exception in the app: they run from a capped agent wallet, only within the limits you approve when you set them up." },
  { icon: Fingerprint, title: "Confirmation before execution", body: "Nothing you start signs itself. A PayAI wallet asks for your passkey on every transaction; a connected wallet asks you to sign. What you approve is what you were shown." },
  { icon: Wallet, title: "Your wallet, or ours", body: "Create a PayAI wallet from a passkey — no seed phrase, because there is nothing for us to hold — or connect the wallet you already use. Link both to one account." },
  { icon: ShieldHalf, title: "Every payment is checked", body: "Before anything sends, we make sure it's going to the right place, for the right amount, within your limits." },
  { icon: Undo2, title: "Cancelled means refunded", body: "Cancel an automation backed by Reserved Funds and what was set aside is released back to you automatically — the same when a schedule finishes its last run." },
  { icon: Zap, title: "Settles on Monad", body: "Payments settle on Monad any time of day, with a transaction hash you can always look up." },
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
            <motion.div key={t.title} initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.05, duration: 0.35 }}>
              <div className="h-full rounded-xl border border-border bg-panel p-5 transition-colors hover:border-primary/30">
                <div className="mb-3 flex h-10 w-10 items-center justify-center text-primary"><t.icon size={22} /></div>
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

/** Why PayAI runs on Monad — each point tied to how PayAI actually works,
 *  with no benchmark figures. */
const WHY_MONAD = [
  { title: "Plans wait on the chain, so the chain has to be quick", body: "A multi-step plan quotes each step only after the one before it has confirmed. Fast confirmation is what keeps a swap-then-send feeling like one action instead of a wait between two." },
  { title: "Many small transactions stay practical", body: "Paying several people is one transaction per recipient, and an automation is one per run. Low fees keep that a sensible way to move money rather than a cost to avoid." },
  { title: "EVM-compatible", body: "PayAI's contracts are standard Solidity, verified on the Monad explorer, and the wallets people already use connect without anything special." },
  { title: "Names and venues that live on Monad", body: ".nad names resolve on-chain, and trades route through supported Monad venues — so a request can name a person and a token the way people actually do." },
];

export function WhyMonadSection() {
  return (
    <section id="why-monad" className="border-t border-border bg-panel/30 py-24 sm:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2 lg:items-center">
        <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}>
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-muted-foreground">
            <MonadMark size={14} /> Built on Monad
          </div>
          <h2 className={H2}>Why we chose Monad</h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            PayAI turns a request into real transactions, often several in a row. That only works well on a chain that confirms quickly, costs little per transaction and runs the tools people already use.
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
