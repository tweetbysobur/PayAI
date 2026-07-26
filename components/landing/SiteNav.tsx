"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";

/**
 * The marketing-site header, shared by /, /product, and /how-it-works.
 *
 * One component rather than a copy per page: three duplicates would drift the
 * first time a link is added, and the active-state logic would have to be
 * reimplemented each time.
 *
 * Layout is logo-left, links-centre, Launch App-right. The links are quiet
 * text, deliberately NOT filled buttons — Launch App is the only primary
 * action on the site, and a second or third purple button would compete with
 * it and dilute the one thing we want clicked.
 *
 * Two links only, so they fit inline at 375px and no hamburger menu is
 * needed. If a third is ever added, revisit that.
 */
const LINKS = [
  { href: "/product", label: "Product" },
  { href: "/how-it-works", label: "How it works" },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="relative z-20 mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-5">
      <Link href="/" className="flex shrink-0 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Logo size={32} />
        <span className="text-sm font-semibold text-foreground">PayAI</span>
      </Link>

      {/* ONE nav, not a desktop copy plus a mobile copy. Two <nav> elements
          with the same label are duplicate landmarks, which is a real
          screen-reader smell even when only one is visible at a time. A
          flex-1 track with justify-center puts the links between the logo and
          the CTA at every width, so no second copy is needed — and with two
          short links they still fit inline at 375px, so no hamburger either. */}
      <nav className="flex flex-1 items-center justify-center gap-0.5 sm:gap-1" aria-label="Main">
        {LINKS.map((l) => {
          const active = pathname === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`whitespace-nowrap rounded-lg px-2 py-2 text-xs font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3 sm:text-sm ${
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-1">
        <Link
          href="/connect"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/25 transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Launch App
        </Link>
      </div>
    </header>
  );
}
