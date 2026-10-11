"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, ArrowLeftRight, UsersRound, Settings,
  Rocket, BookOpen, Lock, HelpCircle, Compass,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { AskMark } from "@/components/AskMark";
import { reopenOnboarding } from "@/lib/hooks/useOnboarding";
import { startGuidedTour } from "@/components/onboarding/TourOverlay";
import { NavigationItem, isNavActive, type NavigationEntry } from "@/components/dashboard/primitives";

/* ── Information architecture ─────────────────────────────────────────────
 *
 * Five primary destinations, nothing else competing with them:
 *
 *   Dashboard                what's happening, what's next, what needs you
 *   Ask PayAI                describe it; PayAI plans it; your wallet signs
 *   Rooms                    shared payment rooms (open rooms; verified rooms still blocked)
 *   Payments & Automations   send, swap, automate, history, recipients
 *   Settings                 account, wallets, security
 *
 * Every page that used to be its own sidebar row still exists at the same
 * URL — it moved one level down, into its area's tabs (PAYMENTS_AREA and
 * SETTINGS_AREA below, rendered by AreaTabs in app/dashboard/layout.tsx).
 * Plans are not a destination: planning happens inside Ask PayAI. Help and
 * the learning links sit in the sidebar's footer, out of the primary list.
 */

/** The second level of Payments & Automations. Swap has no form of its own —
 *  swaps run through Ask PayAI — so its tab is a short page that hands off. */
export const PAYMENTS_AREA: { href: string; label: string; soon?: boolean; match?: readonly string[] }[] = [
  { href: "/dashboard/payments", label: "Send" },
  { href: "/dashboard/swap", label: "Swap" },
  { href: "/dashboard/automations", label: "Automations" },
  { href: "/dashboard/transactions", label: "History" },
  { href: "/dashboard/recipients", label: "Recipients" },
  { href: "/dashboard/invoices", label: "Invoices", soon: true },
];

/** The second level of Settings. Wallets is its own page because it carries
 *  real wallet management (linking, switching, recovery). */
export const SETTINGS_AREA: { href: string; label: string; soon?: boolean; match?: readonly string[] }[] = [
  { href: "/dashboard/settings", label: "General" },
  { href: "/dashboard/wallets", label: "Wallets" },
];

export const NAV: NavigationEntry[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/ask", label: "Ask PayAI", icon: AskMark },
  { href: "/dashboard/rooms", label: "Rooms", icon: UsersRound },
  { href: "/dashboard/payments", label: "Payments & Automations", icon: ArrowLeftRight, match: PAYMENTS_AREA.map((t) => t.href) },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, match: SETTINGS_AREA.map((t) => t.href) },
];

/** Help and learning — the sidebar footer, not the primary list. Support is a
 *  tab inside Help Center (app/dashboard/help/page.tsx). */
export const HELP_LINK = { href: "/dashboard/help", label: "Help Center", icon: BookOpen } as const;

export const LEARN_LINKS: { label: string; icon: typeof LayoutDashboard; href?: string; action?: "onboarding" | "tour"; external?: boolean }[] = [
  { label: "Getting Started", icon: Rocket, action: "onboarding" as const },
  { label: "Take a Tour", icon: Compass, action: "tour" as const },
  { label: "Wallet Security", icon: Lock, href: "/security" },
  { label: "FAQs", icon: HelpCircle, href: "/dashboard/help?category=faq" },
];

/** Maps a NAV href to the `data-tour` id TourOverlay's steps target (see
 *  components/onboarding/TourOverlay.tsx). */
export const TOUR_TARGETS: Record<string, string> = {
  "/dashboard/ask": "ask",
  "/dashboard/rooms": "rooms",
  "/dashboard/payments": "payments",
  "/dashboard/settings": "settings",
  "/dashboard/help": "help",
};

/** The footer list (help + learn), shared by the sidebar and mobile drawer.
 *  The drawer leaves out "Take a Tour": the tour spotlights the desktop
 *  sidebar, which isn't on screen at that width, so it would do nothing. */
export function NavFooter({ onNavigate, withTour = true }: { onNavigate?: () => void; withTour?: boolean }) {
  const pathname = usePathname();
  const cls = "flex min-h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-input/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const helpActive = isNavActive(pathname, HELP_LINK);
  return (
    <div className="space-y-0.5">
      <Link
        href={HELP_LINK.href}
        onClick={onNavigate}
        data-tour={TOUR_TARGETS[HELP_LINK.href]}
        aria-current={helpActive ? "page" : undefined}
        className={`${cls} ${helpActive ? "bg-input text-foreground" : ""}`}
      >
        <HELP_LINK.icon size={15} /> {HELP_LINK.label}
      </Link>
      {LEARN_LINKS.filter((item) => withTour || item.action !== "tour").map((item) => {
        const Icon = item.icon;
        const content = <><Icon size={15} /> {item.label}</>;
        if (item.action === "onboarding") {
          return <button key={item.label} type="button" onClick={() => { onNavigate?.(); reopenOnboarding(); }} className={cls}>{content}</button>;
        }
        if (item.action === "tour") {
          return <button key={item.label} type="button" onClick={() => { onNavigate?.(); startGuidedTour(); }} className={cls}>{content}</button>;
        }
        return item.external
          ? <a key={item.label} href={item.href} target="_blank" rel="noreferrer" onClick={onNavigate} className={cls}>{content}</a>
          : <Link key={item.label} href={item.href ?? "#"} onClick={onNavigate} className={cls}>{content}</Link>;
      })}
    </div>
  );
}

/** The primary list, shared by the sidebar and mobile drawer. */
export function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-0.5">
      {NAV.map((entry) => (
        <li key={entry.href}>
          <NavigationItem entry={entry} active={isNavActive(pathname, entry)} onNavigate={onNavigate} tour={TOUR_TARGETS[entry.href]} />
        </li>
      ))}
    </ul>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-background lg:flex">
      <Link href="/dashboard" title="Dashboard home" className="flex h-[61px] items-center gap-2 border-b border-border px-5 transition-colors hover:bg-input/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <Logo size={28} />
        <p className="text-sm font-semibold text-foreground">PayAI</p>
      </Link>

      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
        <NavList />
      </nav>

      <div className="border-t border-border px-3 py-3">
        <NavFooter />
      </div>
    </aside>
  );
}
