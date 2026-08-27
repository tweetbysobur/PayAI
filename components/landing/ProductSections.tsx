"use client";

import { Fragment } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowRight, Sparkles, ShieldCheck, Send, ArrowLeftRight, Layers,
  Repeat2, Wallet, Activity, Hash, FileCheck, CheckCircle2, Lock, Eye,
} from "lucide-react";
import { MonadMark } from "@/components/MonadMark";

/**
 * /product's core-positioning sections: PayAI as one natural-language intent
 * layer, not a bundle of separate products. Payments, trading, DeFi and
 * automation are capabilities of the same intent → interpretation → approval
 * → execution → verification model, not six unrelated tools — so these
 * sections build and reuse ONE shared visual language (stage chips, divided
 * panels) rather than giving each capability its own distinct card style the
 * way an actual product bundle would.
 *
 * Nothing here claims a capability the codebase doesn't have. In particular:
 * DeFi is currently Monad's DEX and launchpad infrastructure (the same
 * venues Trading uses) — there is no separate lending/staking/pool-deposit
 * feature yet, so the DeFi section says exactly that instead of implying
 * one exists.
 */

const SECTION = "border-t border-border py-24 sm:py-28";
const H2 = "text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground";
const SUB = "mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground";

function Head({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }}
      className="mb-12 text-center"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-ink">{eyebrow}</p>
      <h2 className={H2}>{title}</h2>
      <p className={SUB}>{body}</p>
    </motion.div>
  );
}

/* ── Core product — the visual centerpiece: 3 premium cards, one shared
     intent → plan → approval → execution flow inside each ────────────────── */

const MINI_STAGES = ["Intent", "PayAI plan", "Approval", "Monad tx"];

function MiniFlow() {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-1.5">
      {MINI_STAGES.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <div aria-hidden className="h-px w-3 shrink-0 bg-border" />}
          <span className="rounded-full border border-border bg-input/50 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
            {s}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** DeFi's example is deliberately not "deposit into a pool" — PayAI has no
 *  lending/liquidity-pool feature today. Nad.Fun's bonding-curve buy/sell is
 *  the real DeFi-adjacent action distinct from a plain DEX trade, so it
 *  stands in as the honest example instead. */
const CORE_CARDS = [
  { icon: Send, label: "PAYMENTS", intent: "Send 500 USDC to three wallets every Friday." },
  { icon: ArrowLeftRight, label: "TRADING", intent: "Swap 0.2 MON for USDC." },
  { icon: Layers, label: "DEFI", intent: "Buy 5 MON worth of a new token on Nad.Fun." },
];

export function CoreProductSection() {
  return (
    <section id="core" className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="The core"
          title="One intent layer. Multiple on-chain actions."
          body="Express what you want in natural language and let PayAI coordinate the underlying blockchain actions."
        />
        <div className="grid gap-5 md:grid-cols-3">
          {CORE_CARDS.map((c, i) => (
            <motion.div
              key={c.label}
              initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }} transition={{ delay: i * 0.08, duration: 0.4 }}
              className="rounded-2xl border border-border bg-panel p-6 ring-1 ring-inset ring-white/[0.02] transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30"
            >
              <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/12 text-primary-ink">
                <c.icon size={19} />
              </span>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary-ink">{c.label}</p>
              <p className="mt-3 rounded-lg border border-border bg-background/50 px-3 py-2.5 text-[13px] italic leading-snug text-foreground">
                &ldquo;{c.intent}&rdquo;
              </p>
              <MiniFlow />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── From intent to execution — the strongest visual element on the page ─── */

const INTERPRET_FIELDS = [
  { k: "Action", v: "Swap" },
  { k: "Asset", v: "MON → USDC" },
  { k: "Amount", v: "0.1 MON" },
  { k: "Route", v: "Best available Monad venue" },
  { k: "Constraints", v: "Slippage checked" },
];

const EXECUTION_ROWS = [
  { icon: MonadMark, label: "Supported Monad protocol", value: "Uniswap · Kuru · Nad.Fun", brand: true },
  { icon: ShieldCheck, label: "PayAI execution contract", value: "Executes exactly what was approved" },
  { icon: Wallet, label: "User wallet", value: "Signs before anything moves" },
];

const VERIFICATION_ROWS = [
  { icon: Hash, label: "Transaction hash", value: "Recorded on Monad" },
  { icon: FileCheck, label: "Contract event", value: "Emitted on execution" },
  { icon: CheckCircle2, label: "Final result", value: "Shown in Activity" },
];

export function IntentToExecutionSection() {
  return (
    <section id="flow" className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto max-w-4xl px-6">
        <Head
          eyebrow="From intent to execution"
          title="One request. One execution flow."
          body="Every action PayAI takes — a payment, a trade, a DeFi interaction — moves through the same four stages."
        />

        <motion.div
          initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.5 }}
          className="overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-b from-primary/[0.06] via-panel to-panel shadow-[0_30px_80px_-35px_hsl(var(--primary)/0.4)]"
        >
          <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* Stage 1 — User intent */}
          <div className="p-6 sm:p-7">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">User intent</p>
            <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-border bg-input/40 px-3.5 py-3">
              <Sparkles size={15} className="shrink-0 text-primary-ink" />
              <p className="text-sm text-foreground">&ldquo;Trade 0.1 MON for USDC&rdquo;</p>
            </div>
          </div>

          {/* Stage 2 — PayAI interprets */}
          <div className="border-t border-primary/15 p-6 sm:p-7">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">PayAI interprets</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {INTERPRET_FIELDS.map((f) => (
                <span key={f.k} className="rounded-full border border-border bg-input/60 px-3 py-1.5 text-[11px] font-medium text-foreground">
                  <span className="text-muted-foreground">{f.k}:</span> {f.v}
                </span>
              ))}
            </div>
          </div>

          {/* Stage 3 — Execution */}
          <div className="border-t border-primary/15 p-6 sm:p-7">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Execution</p>
            <div className="mt-3 space-y-2">
              {EXECUTION_ROWS.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-3.5 py-2.5">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {r.brand ? <MonadMark size={13} /> : <r.icon size={13} className="text-primary-ink" />} {r.label}
                  </span>
                  <span className="text-xs font-medium text-foreground">{r.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Stage 4 — Verification */}
          <div className="border-t border-primary/15 bg-primary/[0.04] p-6 sm:p-7">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary-ink">Verification</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {VERIFICATION_ROWS.map((r) => (
                <div key={r.label} className="flex items-center gap-2 rounded-lg border border-primary/20 bg-background/40 px-3 py-2.5">
                  <r.icon size={14} className="shrink-0 text-primary-ink" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-foreground">{r.label}</p>
                    <p className="truncate text-[10px] text-muted-foreground">{r.value}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* ── Capabilities — one interface, not six products ─────────────────────── */

const CAPABILITIES = [
  { icon: Send, title: "Payments", body: "Send, schedule, and distribute funds." },
  { icon: ArrowLeftRight, title: "Trading", body: "Trade tokens across supported Monad venues." },
  { icon: Layers, title: "DeFi", body: "Interact with supported Monad protocols." },
  { icon: Repeat2, title: "Automation", body: "Set a schedule once; PayAI runs it on time." },
  { icon: Wallet, title: "Wallet", body: "Create or connect a wallet you control." },
  { icon: Activity, title: "Activity", body: "See every execution, verified on-chain." },
];

export function CapabilitiesSection() {
  return (
    <section id="capabilities" className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="Built around your intent"
          title="One interface for on-chain actions."
          body="Payments, trading, DeFi, and automation are capabilities of the same intent layer — reachable from one interface, not six separate products."
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c, i) => (
            <motion.div
              key={c.title}
              initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }} transition={{ delay: (i % 3) * 0.05, duration: 0.3 }}
              className="flex items-center gap-3.5 rounded-xl border border-border bg-panel/50 p-4"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
                <c.icon size={17} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{c.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{c.body}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── DeFi — honest about what's actually integrated today ────────────────── */

const DEFI_VENUES = ["Uniswap", "Kuru", "Nad.Fun"];

export function DeFiSection() {
  return (
    <section id="defi" className={SECTION}>
      <div className="mx-auto max-w-2xl px-6 text-center">
        <Head
          eyebrow="DeFi"
          title="Interact with supported Monad protocols through natural-language intent."
          body="Today, PayAI's DeFi interactions run through Monad's DEX and launchpad infrastructure — the same execution venues Trading uses. Broader protocol support is added as it's implemented, never claimed ahead of it."
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          {DEFI_VENUES.map((v) => (
            <span key={v} className="rounded-full border border-border bg-input/50 px-3 py-1.5 text-xs font-medium text-foreground">
              {v}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Verification & security — four compact, checkable claims ────────────── */

const VERIFICATION_CARDS = [
  { icon: Lock, title: "Non-custodial", body: "You remain in control of your wallet and assets." },
  { icon: MonadMark, title: "On-chain execution", body: "Transactions execute through supported smart contracts.", brand: true },
  { icon: Eye, title: "Traceable", body: "PayAI execution can be independently verified on-chain." },
  { icon: ShieldCheck, title: "Safe-controlled infrastructure", body: "Critical execution controls remain protected by the PayAI Safe." },
];

export function VerificationSection() {
  return (
    <section id="verification" className={`${SECTION} bg-panel/20`}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="Verifiable by design"
          title="Built to be checked, not just trusted."
          body="Every claim below is something you can independently verify on Monad."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {VERIFICATION_CARDS.map((c, i) => (
            <motion.div
              key={c.title}
              initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }} transition={{ delay: i * 0.06, duration: 0.3 }}
              className="rounded-xl border border-border bg-panel p-5"
            >
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
                {c.brand ? <MonadMark size={18} /> : <c.icon size={18} />}
              </span>
              <h3 className="text-sm font-semibold text-foreground">{c.title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{c.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Intent examples — demonstrate the interface, not a template catalog ─── */

const INTENT_EXAMPLES = [
  "Send 100 USDC to my team every Friday.",
  "Swap 0.1 MON for USDC.",
  "Pay this wallet 50 USDC tomorrow.",
  "Distribute 1,000 USDC across these addresses.",
];

export function IntentExamplesSection() {
  return (
    <section id="examples" className={SECTION}>
      <div className="mx-auto max-w-4xl px-6 text-center">
        <Head
          eyebrow="Start with an intent"
          title="Just say what you want."
          body="Real sentences PayAI understands today — the interface itself, not another template catalog."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {INTENT_EXAMPLES.map((e, i) => (
            <motion.div
              key={e}
              initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }} transition={{ delay: i * 0.06, duration: 0.3 }}
              className="flex items-center gap-3 rounded-xl border border-border bg-panel/50 px-4 py-3.5 text-left"
            >
              <Sparkles size={14} className="shrink-0 text-primary-ink" />
              <p className="text-sm text-foreground">&ldquo;{e}&rdquo;</p>
            </motion.div>
          ))}
        </div>
        <Link
          href="/dashboard/ask"
          className="mt-8 inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90"
        >
          Try it in Ask PayAI <ArrowRight size={14} />
        </Link>
      </div>
    </section>
  );
}
