"use client";

import { useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { TEMPLATE_CATEGORIES, TEMPLATES, workflowStatus, type TemplateCategory } from "@/lib/automation/templates";

/**
 * Automation Templates, on the landing page.
 *
 * Reads the REAL template registry (lib/automation/templates.ts) — the exact
 * same source the in-app picker uses — rather than a hardcoded marketing
 * list. That matters: a duplicated list would silently drift the moment a
 * template is added, renamed, or removed, and the page would start
 * advertising automations the product doesn't have. Add a template in one
 * place and it appears here automatically.
 *
 * "Custom" is filtered out: it isn't a template, it's the escape hatch for
 * building from scratch, and it has no entries to show. So is anything not
 * finished — this section offers starting points, and an offer you cannot
 * take is not one. Breadth is the job of the payment-operations section
 * above, which describes what can be BUILT rather than what is pre-filled;
 * this one lists only what opens when you click it.
 *
 * The question this section answers: "can PayAI do MY thing?" So it leads
 * with categories a visitor can self-identify with, and the copy stays out
 * of the way — the template names are the content.
 */
export function TemplateShowcase() {
  const ready = TEMPLATES.filter((t) => workflowStatus(t) !== "coming_soon");
  const categories = TEMPLATE_CATEGORIES.filter(
    (c) => c.id !== "custom" && ready.some((t) => t.category === c.id),
  );
  const [active, setActive] = useState<TemplateCategory>(categories[0]?.id ?? "personal");
  const shown = ready.filter((t) => t.category === active);

  return (
    <section id="templates" className="border-t border-border py-24 sm:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }} transition={{ duration: 0.45, ease: "easeOut" }}
          className="mb-10 text-center"
        >
          <h2 className="text-3xl font-semibold tracking-tighter sm:text-4xl text-foreground">
            Start from a template
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {/* Counted, never written by hand — the page cannot claim more
                than the registry actually offers. */}
            {ready.length} ready to use today. Each one pre-fills sensible defaults — cadence, funding mode,
            purpose — and every field stays editable before you activate it.
          </p>
        </motion.div>

        {/* Category selector. Real labels and emoji straight from the registry.
            Hidden when there is only one category with ready templates — a
            single tab is a control that does nothing. */}
        <div className={`mb-8 flex-wrap items-center justify-center gap-2 ${categories.length > 1 ? "flex" : "hidden"}`}>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActive(c.id)}
              aria-pressed={active === c.id}
              /* min-h-11 (44px) at every breakpoint, deliberately not
                 overridden per-breakpoint. These were 29px, under every
                 platform's minimum tap target, and they're the primary
                 interaction in this section. A `sm:min-h-0` override does NOT
                 work here: Tailwind emits min-h-0 before min-h-11, and a media
                 query adds no specificity, so source order makes min-h-11 win
                 on desktop anyway. One accessible size is both correct and
                 simpler than fighting utility ordering. */
              className={`inline-flex min-h-11 items-center rounded-full border px-4 py-1.5 text-xs font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                active === c.id
                  ? "border-primary/50 bg-primary/10 text-primary-ink"
                  : "border-border text-muted-foreground hover:-translate-y-0.5 hover:border-primary/30 hover:text-foreground"
              }`}
            >
              <span aria-hidden className="mr-1">{c.emoji}</span>
              {c.label}
            </button>
          ))}
        </div>

        {/* Deliberately NOT wrapped in <AnimatePresence mode="wait">. That
            keeps the outgoing list mounted until its exit animation finishes,
            so if the exit never completes — a throttled/background tab, a
            browser not compositing frames, reduced-motion — the old category
            stays on screen forever and clicking a tab appears to do nothing.
            Reproduced exactly that here. Keying the div on `active` remounts
            it synchronously on click and still plays the enter animation, so
            the content swap can never be blocked by an animation. */}
          <motion.div
            key={active}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {shown.map((t) => (
              <div
                key={t.id}
                className="group flex gap-3.5 rounded-xl border border-border bg-panel/50 p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-panel"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary-ink transition-colors duration-200 group-hover:border-primary/30">
                  <t.icon size={16} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-semibold tracking-tight text-foreground">{t.name}</p>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                </div>
              </div>
            ))}
          </motion.div>

        <div className="mt-10 text-center">
          <Link
            href="/auth"
            className="inline-flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input"
          >
            {/* "all N" would promise N usable workflows; the live count is the
                honest number to put on a call to action. */}
            Start automating <ArrowRight size={14} className="text-primary-ink" />
          </Link>
        </div>
      </div>
    </section>
  );
}
