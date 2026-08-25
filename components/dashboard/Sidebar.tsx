"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  LayoutDashboard, ArrowUpRight, Receipt, Users, FileText,
  Wallet, Settings, Repeat,
  GraduationCap, Rocket, BookOpen, Lock, HelpCircle, Compass,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { AskMark } from "@/components/AskMark";
import { reopenOnboarding } from "@/lib/hooks/useOnboarding";
import { startGuidedTour } from "@/components/onboarding/TourOverlay";

// "Contact Support" used to live here too, pointing at the exact same
// /dashboard/support page the main nav's own "Support" item already covered.
// Support itself is now a tab inside Help Center (see
// app/dashboard/help/page.tsx) rather than a competing top-level entry, so
// neither ever needs a separate line here again.
export const LEARN_LINKS: { label: string; icon: typeof LayoutDashboard; href?: string; action?: "onboarding" | "tour"; external?: boolean }[] = [
  { label: "Getting Started", icon: Rocket, action: "onboarding" as const },
  { label: "Take a Tour", icon: Compass, action: "tour" as const },
  { label: "Wallet Security", icon: Lock, href: "/security" },
  { label: "FAQs", icon: HelpCircle, href: "/dashboard/help?category=faq" },
];

// Activity, Analytics and Compliance used to be separate entries here, each
// its own page. They're now tabs on Transactions (see
// app/dashboard/transactions/page.tsx) — one destination for everything
// related to what's happened with your payments, instead of four.
/** Widened from `typeof LayoutDashboard` (lucide's own icon type) so an entry
 *  can carry a first-party mark as easily as a lucide glyph — Ask PayAI uses
 *  its own. Only `size` is ever passed, which both satisfy. */
type NavIcon = ComponentType<{ size?: number; className?: string }>;

export const NAV: { href: string; label: string; icon: NavIcon; section: string | null; soon?: boolean }[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, section: null },
  { href: "/dashboard/ask", label: "Ask PayAI", icon: AskMark, section: null },
  { href: "/dashboard/payments", label: "Send Payment", icon: ArrowUpRight, section: "Payments" },
  { href: "/dashboard/automations", label: "Automations", icon: Repeat, section: "Payments" },
  { href: "/dashboard/transactions", label: "Transactions", icon: Receipt, section: "Payments" },
  { href: "/dashboard/recipients", label: "Recipients", icon: Users, section: "Payments" },
  { href: "/dashboard/invoices", label: "Invoices", icon: FileText, section: "Payments", soon: true },
  { href: "/dashboard/wallets", label: "Wallets", icon: Wallet, section: "Settings" },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, section: "Settings" },
  { href: "/dashboard/help", label: "Help Center", icon: BookOpen, section: "Settings" },
] as const;

/** Maps a NAV href to the `data-tour` id TourOverlay's steps target (see
 *  components/onboarding/TourOverlay.tsx). Only hrefs the guided tour
 *  actually spotlights need an entry — everything else renders with no
 *  `data-tour` attribute at all. */
const TOUR_TARGETS: Record<string, string> = {
  "/dashboard/ask": "ask",
  "/dashboard/payments": "payments",
  "/dashboard/automations": "automations",
  "/dashboard/wallets": "wallets",
  "/dashboard/help": "help",
};

/** Real fintech-dashboard sidebar — grouped sections, active-route highlight. */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden h-screen w-60 flex-col border-r border-border bg-panel/60 lg:flex">
      <Link href="/" title="Back to home" className="flex items-center gap-2 border-b border-border px-5 py-5 transition hover:bg-input/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <Logo size={32} />
        <div>
          <p className="text-sm font-semibold leading-none text-foreground">PayAI</p>
        </div>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV.map((item, idx) => {
          const isFirstOverview = item.href === "/dashboard" && item.section === null;
          // Derived from the previous entry rather than a running variable
          // mutated mid-render: NAV is static, so "is this the first item of
          // its section" is a pure function of the index.
          const showSectionLabel = item.section !== null && item.section !== (NAV[idx - 1]?.section ?? null);
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <div key={item.href}>
              {isFirstOverview && <div className="mb-1" />}
              {showSectionLabel && (
                <p className="mb-1.5 mt-4 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">{item.section}</p>
              )}
              <Link
                href={item.href}
                aria-disabled={item.soon}
                aria-current={active ? "page" : undefined}
                data-tour={TOUR_TARGETS[item.href]}
                className={`relative mb-0.5 flex items-center justify-between rounded-md px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active ? "bg-primary/15 text-primary-ink" : "text-muted-foreground hover:bg-input hover:text-foreground"
                } ${item.soon ? "pointer-events-none opacity-50" : ""}`}
              >
                {active && <span className="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-r-full bg-primary" />}
                <span className="flex items-center gap-2.5">
                  <Icon size={16} />
                  {item.label}
                </span>
                {item.soon && <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Soon</span>}
              </Link>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-border px-3 py-3">
        <p className="mb-1 flex items-center gap-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
          <GraduationCap size={12} /> Learn PayAI
        </p>
        {LEARN_LINKS.map((item) => {
          const Icon = item.icon;
          const content = (
            <span className="flex items-center gap-2.5">
              <Icon size={15} />
              {item.label}
            </span>
          );
          const cls = "flex items-center rounded-md px-3 py-1.5 text-[13px] text-muted-foreground transition hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
          if (item.action === "onboarding") {
            return <button key={item.label} onClick={() => reopenOnboarding()} className={`w-full text-left ${cls}`}>{content}</button>;
          }
          if (item.action === "tour") {
            return <button key={item.label} onClick={() => startGuidedTour()} className={`w-full text-left ${cls}`}>{content}</button>;
          }
          return item.external
            ? <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className={cls}>{content}</a>
            : <Link key={item.label} href={item.href ?? "#"} className={cls}>{content}</Link>;
        })}
      </div>
    </aside>
  );
}
