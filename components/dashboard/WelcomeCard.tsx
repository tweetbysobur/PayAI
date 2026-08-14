"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Repeat, Send, Download, LayoutTemplate, ArrowRight } from "lucide-react";
import { useUsername } from "@/lib/hooks/useUsername";
import { NAV } from "@/components/dashboard/Sidebar";

/**
 * The first thing a brand-new wallet sees on the dashboard.
 *
 * A dashboard with no payments, no automations and no balance is technically
 * accurate and completely useless — it tells someone they have nothing rather
 * than what to do next. This answers "what now?" with four concrete starting
 * points, and disappears for good once there is real activity to show
 * (`show={false}`), so it never becomes clutter for an established user.
 */
const ACTIONS = [
  {
    href: "/dashboard/automations",
    title: "Create Payment Automation",
    blurb: "Schedule a payment that runs on its own.",
    icon: Repeat,
    primary: true,
  },
  { href: "/dashboard/payments", title: "Send Money", blurb: "Pay any address or .nad name.", icon: Send },
  { href: "/connect", title: "Import Existing Wallet", blurb: "Use MetaMask, Rabby or Backpack instead.", icon: Download },
  { href: "/dashboard/automations", title: "Explore Templates", blurb: "Payroll, treasury, rewards and more.", icon: LayoutTemplate },
];

/** One-line descriptions for the sidebar's own nav items, keyed by href so
 *  the tour below can never list a page the sidebar doesn't have (or drift
 *  out of sync with its labels/icons/grouping) — it reads `NAV` directly. */
const TOUR_BLURBS: Record<string, string> = {
  "/dashboard/payments": "Pay any wallet address or .nad name.",
  "/dashboard/automations": "Set up recurring or scheduled payments.",
  "/dashboard/transactions": "Every payment you've sent, with receipts.",
  "/dashboard/activity": "A live feed of what's happening on your wallet.",
  "/dashboard/recipients": "Save wallets and register on-chain merchants.",
  "/dashboard/invoices": "Create and share a payment request.",
  "/dashboard/compliance": "The risk checks every payment goes through.",
  "/dashboard/analytics": "Spending trends and approval rates over time.",
  "/dashboard/wallets": "Manage and switch between linked wallets.",
  "/dashboard/settings": "Your username, preferences, and account.",
};

/** Grouped exactly the way the sidebar groups them — computed once from the
 *  same `NAV` list the sidebar renders from, so this tour is a view of the
 *  real navigation, not a second copy of it that can go stale. */
const TOUR_SECTIONS: { name: string; items: typeof NAV }[] = (() => {
  const sections: { name: string; items: typeof NAV }[] = [];
  for (const item of NAV) {
    if (!item.section || item.soon || !TOUR_BLURBS[item.href]) continue;
    let bucket = sections.find((s) => s.name === item.section);
    if (!bucket) { bucket = { name: item.section, items: [] }; sections.push(bucket); }
    bucket.items.push(item);
  }
  return sections;
})();

export function WelcomeCard({ address, show }: { address?: string | null; show: boolean }) {
  const { username } = useUsername(address);
  if (!show) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="mb-5 overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-primary/[0.06] to-transparent p-6"
    >
      <h2 className="text-xl font-semibold tracking-tight text-foreground">
        {/* Greet by name only when they've chosen one — greeting someone by
            their wallet address is worse than not greeting them at all. */}
        Welcome to PayAI{username ? `, @${username}` : ""}.
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Your wallet is ready. What would you like to automate today?
      </p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {ACTIONS.map((a, i) => {
          const Icon = a.icon;
          return (
            <motion.div
              key={a.title}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + i * 0.05, duration: 0.3, ease: "easeOut" }}
            >
              <Link
                href={a.href}
                className={`group flex h-full items-start gap-3 rounded-xl border px-4 py-4 transition-all duration-150 hover:-translate-y-0.5 ${
                  a.primary
                    ? "border-primary/40 bg-primary/[0.06] hover:border-primary"
                    : "border-border bg-panel hover:border-primary/40 hover:bg-input/40"
                }`}
              >
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${a.primary ? "bg-primary/15 text-primary-ink" : "bg-input text-muted-foreground"}`}>
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    {a.title}
                    <ArrowRight size={13} className="text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{a.blurb}</span>
                </span>
              </Link>
            </motion.div>
          );
        })}
      </div>

      {/* Quick tour — what lives where, so the sidebar isn't a wall of
          unfamiliar labels on day one. Grouped and linked exactly like the
          sidebar itself. */}
      <div className="mt-6 border-t border-border pt-5">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          A quick tour — where to find things
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {TOUR_SECTIONS.map((section) => (
            <div key={section.name}>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">{section.name}</p>
              <ul className="space-y-1">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="group flex items-start gap-2 rounded-lg px-1.5 py-1 transition hover:bg-input/40"
                      >
                        <Icon size={13} className="mt-0.5 shrink-0 text-muted-foreground transition group-hover:text-primary-ink" />
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-foreground">{item.label}</span>
                          <span className="block text-[11px] leading-relaxed text-muted-foreground">{TOUR_BLURBS[item.href]}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </motion.section>
  );
}
