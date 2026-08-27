"use client";

import { motion } from "motion/react";
import {
  ArrowRight, ChevronDown, Sparkles,
  Layers, Eye, KeyRound, RotateCw,
  MessageSquare, Target, Zap, ShieldCheck, BadgeCheck,
} from "lucide-react";
import { MonadMark } from "@/components/MonadMark";

/**
 * The landing page's "problem, then PayAI" section — replaces an earlier
 * "manual vs automated recurring payments" framing that only spoke to one
 * product (Wallet Automation). PayAI's pitch is broader now (payments,
 * trading, DeFi, one natural-language interface), so the comparison itself
 * had to stop being payment-specific: the left side is "juggling wallets and
 * protocols yourself" in general, not "forgetting to send a payment".
 *
 * The PayAI card is deliberately the visual focal point (glow, elevation,
 * larger typography) — it's the side of the comparison the page is arguing
 * for. The flow strip at the bottom concretizes the pitch with one real,
 * representative example rather than an abstract diagram; no fabricated
 * numbers or claims beyond "this is what happens when you describe this".
 */

const WITHOUT_PAYAI = [
  { icon: Layers, t: "Switch between wallets and protocols" },
  { icon: Eye, t: "Understand each transaction yourself" },
  { icon: KeyRound, t: "Manage approvals and routing" },
  { icon: RotateCw, t: "Repeat the same process every time" },
];

const WITH_PAYAI = [
  { icon: MessageSquare, t: "Natural-language intent" },
  { icon: Target, t: "Describe the outcome you want" },
  { icon: Zap, t: "PayAI coordinates the execution" },
  { icon: ShieldCheck, t: "Review and approve before signing" },
  { icon: BadgeCheck, t: "Every execution remains verifiable on-chain" },
];

/** A single stage in the compact intent → execution flow strip. Connector
 *  between stages is a right-arrow on desktop, a down-chevron on mobile
 *  (rendered by the parent, not here, since it sits between two of these). */
function FlowStage({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function FlowConnector() {
  return (
    <>
      <ChevronDown size={14} className="mx-auto shrink-0 text-primary-ink/50 sm:hidden" />
      <ArrowRight size={14} className="hidden shrink-0 text-primary-ink/50 sm:block" />
    </>
  );
}

export function IntentSection() {
  return (
    <section id="why" className="mx-auto max-w-6xl px-6 py-24 sm:py-28">
      <motion.div initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.4 }} className="mb-12 text-center">
        <h2 className="text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground">
          Tell PayAI what you want. We handle the on-chain execution.
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Turn natural-language intent into payments, trades, and DeFi actions on Monad — without navigating multiple interfaces.
        </p>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {/* WITHOUT PAYAI — deliberately flat and plain: no glow, no elevation,
            muted throughout. The contrast against the PayAI card IS the point. */}
        <motion.div
          initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.35 }}
          className="rounded-3xl border border-border bg-panel/50 p-7 sm:p-8"
        >
          <p className="mb-6 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Without PayAI</p>
          <ul className="space-y-4">
            {WITHOUT_PAYAI.map((w) => (
              <li key={w.t} className="flex items-start gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-input/70 text-muted-foreground">
                  <w.icon size={16} />
                </span>
                <span className="pt-2 text-sm leading-relaxed text-muted-foreground">{w.t}</span>
              </li>
            ))}
          </ul>
        </motion.div>

        {/* WITH PAYAI — the card the page is arguing for: elevated, glowing,
            larger padding/type, and the only card with an internal flow demo. */}
        <motion.div
          initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ delay: 0.08, duration: 0.4 }}
          className="relative rounded-3xl border border-primary/30 bg-gradient-to-b from-primary/[0.08] via-panel to-panel p-7 shadow-[0_30px_80px_-30px_hsl(var(--primary)/0.45)] sm:p-8 lg:-translate-y-3"
        >
          <div aria-hidden className="pointer-events-none absolute inset-0 rounded-3xl ring-1 ring-inset ring-primary/15" />
          <p className="mb-6 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-ink">
            <Sparkles size={13} /> With PayAI
          </p>
          <ul className="space-y-4">
            {WITH_PAYAI.map((w) => (
              <li key={w.t} className="flex items-start gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary-ink">
                  <w.icon size={16} />
                </span>
                <span className="pt-2 text-sm font-medium leading-relaxed text-foreground">{w.t}</span>
              </li>
            ))}
          </ul>

          {/* Compact intent -> execution flow, one real example. Subtle and
              integrated — a divider and small type, not a separate diagram. */}
          <div className="mt-7 border-t border-primary/15 pt-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-3">
              <FlowStage label="Natural-language intent">
                <p className="rounded-lg border border-border bg-background/50 px-3 py-2.5 text-[12px] italic leading-snug text-foreground">
                  &ldquo;Send 50 USDC to Alice every Friday&rdquo;
                </p>
              </FlowStage>
              <FlowConnector />
              <FlowStage label="PayAI interprets">
                <div className="flex h-full flex-wrap content-start gap-1.5">
                  {["Payment", "Schedule", "Recipient"].map((tag) => (
                    <span key={tag} className="rounded-full border border-border bg-input/60 px-2.5 py-1 text-[11px] font-medium text-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              </FlowStage>
              <FlowConnector />
              <FlowStage label="On-chain execution">
                <p className="flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2.5 text-[12px] font-medium text-primary-ink">
                  <MonadMark size={12} /> Monad transaction
                </p>
              </FlowStage>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
