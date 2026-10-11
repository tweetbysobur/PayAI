"use client";

import { Fragment } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowRight, Sparkles, ShieldCheck, Send, ArrowLeftRight, Layers,
  Repeat2, Wallet, Users, Hash, FileCheck, CheckCircle2, Lock, Eye,
} from "lucide-react";
import { MonadMark } from "@/components/MonadMark";
import { EXECUTION_VENUES } from "@/components/landing/PlatformOverview";
import { CORE_EXAMPLES, PRODUCT_EXAMPLES } from "@/components/landing/intentExamples";

/** The protocols PayAI's own actions call today, besides trading venues. */
const PROTOCOLS = ["Aave V3", "WMON"] as const;

/**
 * /product's core-positioning sections: PayAI as one natural-language intent
 * layer, not a bundle of separate products. Payments, trading, Monad protocols,
 * Rooms and automation are capabilities of the same intent → interpretation → approval
 * → execution → verification model, not six unrelated tools — so these
 * sections build and reuse ONE shared visual language (stage chips, divided
 * panels) rather than giving each capability its own distinct card style the
 * way an actual product bundle would.
 *
 * Nothing here claims a capability the codebase doesn't have. Protocol
 * support today is exactly: wrap/unwrap MON (WMON) and supply/withdraw USDC on
 * Aave V3 (lib/sdk/actions/wmon, aave-v3-monad), plus trades through the
 * supported venues. There is no staking, borrowing or bridging, and the
 * protocols section names what exists rather than "supported protocols".
 * Every example prompt comes from intentExamples.ts and is checked against the
 * product in test/intent-examples.test.ts.
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

/** Every intent shown here has to be one Ask PayAI can actually carry through
 *  to a signable transaction, because the card puts "Monad tx" at the end of
 *  the flow — so they come from intentExamples.ts, where each one is checked
 *  against the real product. */
const CORE_CARDS = [
  { icon: Send, label: "PAYMENTS", intent: CORE_EXAMPLES.payments.say },
  { icon: ArrowLeftRight, label: "TRADING", intent: CORE_EXAMPLES.trading.say },
  { icon: Layers, label: "PROTOCOLS", intent: CORE_EXAMPLES.protocols.say },
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
              className="rounded-2xl border border-border bg-panel p-6 ring-1 ring-inset ring-white/[0.02] transition-all duration-200 hover:border-primary/30"
            >
              <span className="mb-4 flex h-11 w-11 items-center justify-center text-primary">
                <c.icon size={23} />
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

/** `brand` rows render the Monad wordmark and carry no `icon`; every other
 *  row supplies one. Typed as a discriminated union so removing an `icon`
 *  from a non-brand row is a compile error rather than a blank square. */
type ExecutionRow =
  | { brand: true; label: string; value: string }
  | { brand?: false; icon: typeof ShieldCheck; label: string; value: string };

const EXECUTION_ROWS: ExecutionRow[] = [
  { brand: true, label: "Supported Monad protocol", value: EXECUTION_VENUES.join(" · ") },
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
          body="Every action PayAI takes — a payment, a trade, a protocol action — moves through the same four stages."
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
  { icon: Send, title: "Payments", body: "Send, schedule and automate transfers, or pay several people at once." },
  { icon: ArrowLeftRight, title: "Trading", body: "Swap, buy or sell tokens across supported Monad venues." },
  { icon: Layers, title: "Monad protocols", body: "Wrap MON, and supply or withdraw USDC on Aave V3." },
  { icon: Repeat2, title: "Plans", body: "Several actions from one request, reviewed together and run in order." },
  { icon: Users, title: "Rooms", body: "Split a shared cost; each person pays the recipient directly." },
  { icon: Wallet, title: "Wallet & activity", body: "Create or connect a wallet you control, and see every execution verified on-chain." },
];

export function CapabilitiesSection() {
  return (
    <section id="capabilities" className={SECTION}>
      <div className="mx-auto max-w-6xl px-6">
        <Head
          eyebrow="Built around your intent"
          title="One interface for on-chain actions."
          body="Payments, trading, protocols, plans and Rooms are capabilities of the same intent layer — reachable from one interface, not separate products."
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c, i) => (
            <motion.div
              key={c.title}
              initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }} transition={{ delay: (i % 3) * 0.05, duration: 0.3 }}
              className="flex items-center gap-3.5 rounded-xl border border-border bg-panel/50 p-4"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center text-primary">
                <c.icon size={21} />
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

/* ── Monad protocols — exactly what's integrated today ───────────────────── */

/**
 * Venues are rendered as typographic wordmarks, not logos, and that is a
 * deliberate choice rather than a gap left to fill in later.
 *
 * Official marks exist and are legitimately obtainable for some of these
 * (Uniswap) but not for others (Kuru, Nad.Fun) without pulling an unofficial
 * copy from somewhere. Drawing the missing ones by hand would put a mark on
 * the page that is not the brand's actual mark, and mixing two real logos
 * with one invented one is worse than showing none. So every venue gets the
 * same treatment until official assets for all of them are in the repo, at
 * which point this list becomes the single place to swap them in.
 */
export function DeFiSection() {
  return (
    <section id="defi" className={SECTION}>
      <div className="mx-auto max-w-2xl px-6 text-center">
        <Head
          eyebrow="Monad protocols"
          title="Use Monad protocols by saying what you want."
          body="Today that means wrapping and unwrapping MON, and supplying or withdrawing USDC on Aave V3. Trades route through supported Monad venues. More protocols are added as they're built and tested — never listed ahead of that."
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          {[...PROTOCOLS, ...EXECUTION_VENUES].map((v) => (
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

/** The non-custodial line carries the automation caveat deliberately. Every
 *  interactive action is signed by the user's own wallet, but Payment
 *  Automations run from a capped server agent wallet — stating "non-custodial"
 *  flat, with no qualifier, is the one claim this repo treats as off-limits
 *  (see CLAUDE.md). Shortening it back to the bare sentence would be a
 *  regression, not a copy tidy-up. */
const VERIFICATION_CARDS = [
  { icon: Lock, title: "Non-custodial", body: "You remain in control of your wallet and assets. Interactive actions are signed by your own wallet; only Payment Automations run from a capped agent wallet you authorize up front." },
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
              <span className="mb-3 flex h-10 w-10 items-center justify-center text-primary">
                {c.brand ? <MonadMark size={22} /> : <c.icon size={22} />}
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

/** Sentences Ask PayAI acts on today — this block sits directly above a
 *  "Try it in Ask PayAI" button, so anything listed here has to survive the
 *  click. They come from intentExamples.ts and are checked against the real
 *  product (test/intent-examples.test.ts); a prompt with no resolvable
 *  recipient ("pay this wallet…", "…to my team") can't be listed. */
const INTENT_EXAMPLES = PRODUCT_EXAMPLES.map((e) => e.say);

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
