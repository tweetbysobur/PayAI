"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { DOCS_NAV, DOCS_UPDATED, docsNavIsActive } from "@/lib/docs/nav";
import { publicDocsPath } from "@/lib/docs/host";

export interface DocsTocItem {
  id: string;
  title: string;
}

export interface DocsShellProps {
  kicker: string;
  title: string;
  lede: string;
  updated?: string;
  toc?: DocsTocItem[];
  children: React.ReactNode;
  onDocsHost?: boolean;
  appOrigin?: string;
}

export function DocsShell({
  kicker,
  title,
  lede,
  updated = DOCS_UPDATED,
  toc,
  children,
  onDocsHost = false,
  appOrigin = "https://usepayai.xyz",
}: DocsShellProps) {
  const pathname = usePathname();
  const home = onDocsHost ? appOrigin : "/";
  const launch = onDocsHost ? `${appOrigin}/auth` : "/auth";
  const docsHome = publicDocsPath("/docs", onDocsHost);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Link href={home} aria-label="PayAI home" className="flex shrink-0 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Logo size={26} />
              <span className="text-sm font-semibold text-foreground">PayAI</span>
            </Link>
            <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
            <Link href={docsHome} className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline">
              Docs
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={home}
              className="hidden rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Home
            </Link>
            <Link
              href={launch}
              className="inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Launch PayAI
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_176px]">
        <aside className="border-b border-border lg:border-b-0 lg:border-r">
          <div className="lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:overflow-y-auto">
            <details className="group lg:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-foreground">
                Documentation
                <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
                <span className="hidden text-xs text-muted-foreground group-open:inline">Hide</span>
              </summary>
              <DocsNav pathname={pathname} onDocsHost={onDocsHost} className="px-4 pb-4" />
            </details>
            <DocsNav pathname={pathname} onDocsHost={onDocsHost} className="hidden px-5 py-8 lg:block" />
          </div>
        </aside>

        <div className="min-w-0 px-4 py-10 sm:px-8 sm:py-14 lg:px-12">
          <article className="mx-auto max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-ink">{kicker}</p>
            <h1 className="mt-3 font-montserrat text-[1.85rem] font-semibold leading-[1.15] tracking-tight text-foreground sm:text-4xl">
              {title}
            </h1>
            <p className="mt-4 text-[15px] leading-7 text-muted-foreground">{lede}</p>
            <p className="mt-4 text-xs text-muted-foreground/70">Last updated {updated}</p>
            <div className="mt-10 space-y-12">{children}</div>
          </article>
        </div>

        <aside className="hidden xl:block">
          {toc && toc.length > 0 ? (
            <div className="sticky top-14 px-4 py-10">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">On this page</p>
              <nav aria-label="On this page" className="mt-3 space-y-2">
                {toc.map((t) => (
                  <a
                    key={t.id}
                    href={`#${t.id}`}
                    className="block text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t.title}
                  </a>
                ))}
              </nav>
            </div>
          ) : null}
        </aside>
      </div>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} UsePayAI. Not affiliated with PayAI Network.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/security" className="hover:text-foreground">Security</Link>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
            <a href="mailto:support@usepayai.xyz" className="hover:text-foreground">support@usepayai.xyz</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function DocsNav({ pathname, onDocsHost, className }: { pathname: string; onDocsHost: boolean; className?: string }) {
  return (
    <nav aria-label="Documentation" className={className}>
      {DOCS_NAV.map((group) => (
        <div key={group.title} className="mb-6 last:mb-0">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {group.title}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = docsNavIsActive(item.href, pathname, item.exact);
              return (
                <li key={item.href}>
                  <Link
                    href={publicDocsPath(item.href, onDocsHost)}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                      active
                        ? "bg-primary/10 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-white/[0.03] hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function DocsSection({
  id,
  index,
  title,
  children,
}: {
  id: string;
  index?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="flex items-baseline gap-3 text-lg font-semibold tracking-tight text-foreground sm:text-xl">
        {index ? <span className="font-mono text-[11px] font-medium text-primary-ink">{index}</span> : null}
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-7 text-muted-foreground [&_a]:text-primary-ink [&_a]:underline-offset-2 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-white/[0.04] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-foreground [&_strong]:font-medium [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

export function DocsCallout({
  tone = "note",
  title,
  children,
}: {
  tone?: "note" | "warning" | "danger";
  title: string;
  children: React.ReactNode;
}) {
  const border =
    tone === "danger" ? "border-danger/30 bg-danger/[0.06]"
    : tone === "warning" ? "border-warning/30 bg-warning/[0.06]"
    : "border-border bg-panel/50";
  const label =
    tone === "danger" ? "text-danger"
    : tone === "warning" ? "text-warning"
    : "text-primary-ink";
  return (
    <aside className={`rounded-lg border px-4 py-3.5 ${border}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${label}`}>{title}</p>
      <div className="mt-1.5 text-[14px] leading-6 text-muted-foreground">{children}</div>
    </aside>
  );
}

export function DocsTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[28rem] text-left text-[13px]">
        <thead className="border-b border-border bg-panel/60 text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/80">
          {rows.map((row, i) => (
            <tr key={i} className="text-foreground/90">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2.5 align-top leading-5">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
