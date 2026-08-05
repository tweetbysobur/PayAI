"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Repeat, Send, Download, LayoutTemplate, ArrowRight } from "lucide-react";
import { useUsername } from "@/lib/hooks/useUsername";

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
    </motion.section>
  );
}
