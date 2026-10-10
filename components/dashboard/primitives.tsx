"use client";

/**
 * Dashboard layout primitives — the handful of patterns that repeat on every
 * dashboard surface, defined once so they look the same everywhere:
 *
 *   PageHeader       a page's title, one line of context, and its actions
 *   SectionHeader    a section's label inside a page, with an optional link
 *   StatusIndicator  a dot + label for a state (settled, pending, failed …)
 *   ActivityRow      one line of activity: what, when, how much, receipt
 *   EmptyState       what an empty section says, and the one next step
 *   AreaTabs         the second level of navigation inside an area
 *
 * The system they encode: one surface colour (panel) on the canvas, 1px
 * borders, 8px radius, no gradients or glows. Colour carries meaning only —
 * action (primary), selection, and state (success / warning / danger).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { ArrowRight, ExternalLink } from "lucide-react";

type IconType = ComponentType<{ size?: number; className?: string }>;

/* ── Headers ─────────────────────────────────────────────────────────────── */

export function PageHeader({ title, description, actions, eyebrow }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 sm:mb-6">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-xs font-medium text-muted-foreground">{eyebrow}</p>}
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
        {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SectionHeader({ title, href, linkLabel = "View all", right, id }: {
  title: ReactNode;
  href?: string;
  linkLabel?: string;
  right?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id={id} className="text-sm font-semibold text-foreground">{title}</h2>
      {right ?? (href && (
        <Link href={href} className="rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {linkLabel}
        </Link>
      ))}
    </div>
  );
}

/* ── Status ──────────────────────────────────────────────────────────────── */

export type StatusTone = "success" | "warning" | "danger" | "neutral" | "pending";

const DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  pending: "bg-muted-foreground",
  neutral: "bg-muted-foreground/60",
};

const TEXT: Record<StatusTone, string> = {
  success: "text-foreground",
  warning: "text-warning",
  danger: "text-danger",
  pending: "text-muted-foreground",
  neutral: "text-muted-foreground",
};

/** A state, as a small dot and a word. Never colour alone: the label is
 *  always there, so the state reads without colour vision. */
export function StatusIndicator({ tone, label, className = "" }: { tone: StatusTone; label: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${TEXT[tone]} ${className}`}>
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
      {label}
    </span>
  );
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

/** One line of activity. Everything here is real record data — the caller
 *  passes "—" (never an invented value) for anything it doesn't have. */
export function ActivityRow({ icon: Icon, title, meta, amount, status, receipt }: {
  icon: IconType;
  title: ReactNode;
  meta?: ReactNode;
  amount?: ReactNode;
  status?: { tone: StatusTone; label: string };
  receipt?: { href: string; label: string } | null;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5 sm:py-3">
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground">
        <Icon size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{title}</p>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {status && <StatusIndicator tone={status.tone} label={status.label} />}
          {meta && <span className="truncate">{meta}</span>}
        </div>
      </div>
      <div className="shrink-0 text-right">
        {amount != null && <p className="text-sm font-medium tabular-nums text-foreground">{amount}</p>}
        {receipt && (
          <a href={receipt.href} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 rounded-sm font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {receipt.label} <ExternalLink size={10} aria-hidden />
          </a>
        )}
      </div>
    </li>
  );
}

/* ── Empty ───────────────────────────────────────────────────────────────── */

export function EmptyState({ title, hint, action, compact = false }: {
  title: ReactNode;
  hint?: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
  compact?: boolean;
}) {
  const cls = "mt-3 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className={compact ? "py-4" : "py-5 sm:py-8"}>
      <p className="text-sm text-foreground">{title}</p>
      {hint && <p className="mt-1 max-w-md text-sm text-muted-foreground">{hint}</p>}
      {action && (action.href
        ? <Link href={action.href} className={cls}>{action.label} <ArrowRight size={13} aria-hidden /></Link>
        : <button type="button" onClick={action.onClick} className={cls}>{action.label} <ArrowRight size={13} aria-hidden /></button>)}
    </div>
  );
}

/* ── Navigation ──────────────────────────────────────────────────────────── */

export interface NavigationEntry {
  href: string;
  label: string;
  icon: IconType;
  /** Other routes this entry is the active destination for. */
  match?: readonly string[];
  soon?: boolean;
}

/** Whether `pathname` belongs to a nav entry: its own route, or any route it
 *  owns. "/dashboard" itself only matches exactly — every page is under it. */
export function isNavActive(pathname: string, entry: Pick<NavigationEntry, "href" | "match">): boolean {
  const routes = [entry.href, ...(entry.match ?? [])];
  return routes.some((r) => (r === "/dashboard" ? pathname === r : pathname === r || pathname.startsWith(`${r}/`)));
}

/** One primary navigation link — the sidebar's and the mobile drawer's. */
export function NavigationItem({ entry, active, onNavigate, tour }: {
  entry: NavigationEntry;
  active: boolean;
  onNavigate?: () => void;
  tour?: string;
}) {
  const Icon = entry.icon;
  return (
    <Link
      href={entry.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      data-tour={tour}
      className={`relative flex min-h-10 items-center gap-2.5 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "bg-input font-medium text-foreground" : "text-muted-foreground hover:bg-input/60 hover:text-foreground"
      }`}
    >
      {active && <span aria-hidden className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />}
      <Icon size={16} className={active ? "text-primary-ink" : undefined} />
      <span className="truncate">{entry.label}</span>
    </Link>
  );
}

/** The second level inside an area — a row of tabs that scrolls sideways on
 *  a narrow screen rather than wrapping or overflowing the page. */
export function AreaTabs({ label, tabs }: { label: string; tabs: readonly { href: string; label: string; soon?: boolean; match?: readonly string[] }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mx-4 -mt-4 mb-6 flex items-center gap-6 border-b border-border px-4 sm:-mx-6 sm:-mt-6 sm:px-6">
      <p className="hidden shrink-0 text-xs font-medium text-muted-foreground md:block">{label}</p>
      <ul className="-mb-px flex min-w-0 flex-1 gap-5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const active = isNavActive(pathname, t);
          return (
            <li key={t.href} className="shrink-0">
              {t.soon ? (
                <span aria-disabled="true" className="flex items-center gap-1.5 border-b-2 border-transparent py-3 text-sm text-muted-foreground/60">
                  {t.label} <span className="text-[10px] uppercase tracking-wide">Soon</span>
                </span>
              ) : (
                <Link
                  href={t.href}
                  aria-current={active ? "page" : undefined}
                  className={`block border-b-2 py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                    active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
