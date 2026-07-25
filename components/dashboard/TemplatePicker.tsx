"use client";

import { useCallback, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Search, X, ArrowRight, Sparkles } from "lucide-react";
import { TEMPLATE_CATEGORIES, TEMPLATES, type AutomationTemplate, type TemplateCategory } from "@/lib/automation/templates";
import { useModalA11y } from "@/lib/hooks/useModalA11y";

/**
 * Template picker — the primary entry point for creating an automation.
 * Selecting a template (or "Build your own") hands its id back to the
 * caller, which opens the existing creation wizard pre-filled with that
 * template's defaults. This component has no execution logic of its own —
 * it only chooses which defaults to seed the same wizard with.
 */
export function TemplatePicker({ open, onClose, onSelect, onSelectBulk }: {
  open: boolean;
  onClose: () => void;
  onSelect: (template: AutomationTemplate | null) => void;
  /** Bulk Payment templates open the Bulk Payment wizard instead of the
   *  single-recipient one — same "template only pre-fills defaults"
   *  contract, just a different existing wizard to pre-fill. */
  onSelectBulk: (template: AutomationTemplate) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TemplateCategory | "all">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TEMPLATES.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    });
  }, [query, category]);

  const grouped = useMemo(() => {
    const groups = new Map<TemplateCategory, AutomationTemplate[]>();
    for (const t of filtered) {
      if (!groups.has(t.category)) groups.set(t.category, []);
      groups.get(t.category)!.push(t);
    }
    return groups;
  }, [filtered]);

  // Stable identity: useModalA11y depends on this, so an inline function
  // would re-register the Escape listener on every render.
  const close = useCallback(() => {
    setQuery("");
    setCategory("all");
    onClose();
  }, [onClose]);

  useModalA11y(open, close);

  // No AnimatePresence/exit on the overlay, deliberately. AnimatePresence was
  // never completing its exit here, so the faded-out overlay stayed mounted at
  // opacity 0 — invisible but still `pointer-events: auto` and still in the
  // accessibility tree. That silently swallowed every click over the middle of
  // the page after a modal had been opened once, and announced a phantom open
  // dialog to screen readers. Confirmed in-browser, and reproduced on the Bulk
  // Payment modal too. Rendering `{open && …}` directly lets React unmount the
  // node for real; we keep the enter animation and lose only the fade-out.
  return (
    <>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm"
          onClick={close}
        >
          <motion.div
            role="dialog" aria-modal="true" aria-label="Choose an automation template"
            initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <p className="text-base font-semibold tracking-tight text-foreground">What would you like to automate?</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Start from a real workflow, or build your own from scratch.</p>
              </div>
              <button onClick={close} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground"><X size={16} /></button>
            </div>

            <div className="space-y-3 border-b border-border px-6 py-3">
              <div className="relative">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search templates…"
                  className="w-full rounded-lg border border-border bg-input py-2 pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setCategory("all")}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${category === "all" ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"}`}
                >
                  All
                </button>
                {TEMPLATE_CATEGORIES.filter((c) => c.id !== "custom").map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setCategory(c.id)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${category === c.id ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"}`}
                  >
                    {c.emoji} {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {/* Build your own — always visible at the top regardless of filter. */}
              <button
                onClick={() => onSelect(null)}
                className="mb-5 flex w-full items-center gap-3 rounded-xl border border-dashed border-primary/40 bg-primary/[0.04] p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/[0.08]"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary"><Sparkles size={18} /></div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">Build your own</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Start from scratch and configure every detail yourself.</p>
                </div>
                <ArrowRight size={16} className="shrink-0 text-muted-foreground" />
              </button>

              {filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No templates match “{query}”.</p>
              ) : (
                <div className="space-y-6">
                  {TEMPLATE_CATEGORIES.filter((c) => grouped.has(c.id)).map((c) => (
                    <div key={c.id}>
                      <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{c.emoji} {c.label}</p>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {grouped.get(c.id)!.map((t) => (
                          <motion.button
                            key={t.id}
                            onClick={() => (t.category === "bulk" ? onSelectBulk(t) : onSelect(t))}
                            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                            className="group flex flex-col rounded-xl border border-border bg-gradient-to-b from-primary/[0.04] to-transparent p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:from-primary/[0.08]"
                          >
                            <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary"><t.icon size={16} /></div>
                            <p className="text-sm font-semibold text-foreground">{t.name}</p>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                          </motion.button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
