"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { APP_ORIGIN, DOCS_ORIGIN } from "@/lib/hosts";

/**
 * The marketing-site header, shared by /, /product, and /how-it-works.
 *
 * One component rather than a copy per page: three duplicates would drift the
 * first time a link is added, and the active-state logic would have to be
 * reimplemented each time.
 *
 * Layout is logo-left, links-centre, the CTA right. The links are quiet
 * text, deliberately NOT filled buttons — Launch PayAI is the only primary
 * action on the site, and a second or third purple button would compete with
 * it and dilute the one thing we want clicked.
 *
 * Fitting 375px needs real concessions, because logo + wordmark + links + the
 * CTA measured ~421px and the header CLIPS rather than scrolls — the CTA was
 * running to x=399 and was physically unreachable on a phone, which is about
 * as bad as a landing-page bug gets. Below `sm` the wordmark is hidden (the
 * mark alone is still the logo, and it sits beside the page title anyway) and
 * the horizontal padding tightens — header px-3, link px-1.5, CTA px-3, each
 * restored at `sm`. Those three together buy back ~24px, measured: at 320px
 * the CTA's right edge was at 338px against a 320px viewport, i.e. the button
 * was partly off-screen again. /product and /how-it-works showed it as real
 * document overflow; the landing page only LOOKED fine there because its
 * <main> is overflow-hidden, which hides the symptom and not the bug.
 *
 * Security and Docs are the links that do not fit on a phone beside the
 * "Launch PayAI" button. So they are `phoneHidden`: shown from `sm` up, and
 * reachable on a phone from the footer. "How to ask" is a section of
 * /how-it-works, not a page of its own, so it has no link here. Nothing else here is hidden, and no link is
 * hidden at a width where it would fit.
 */
const LINKS = [
  { href: "/product", label: "Product", phoneHidden: false },
  { href: "/how-it-works", label: "How it works", phoneHidden: false },
  // Five links plus the CTA overrun the header at sm (640px, measured: the
  // CTA was pushed off-screen), so this one joins from md up.
  { href: DOCS_ORIGIN, label: "Docs", phoneHidden: true },
  { href: "/security", label: "Security", phoneHidden: true },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="relative z-20 mx-auto flex max-w-7xl items-center justify-between gap-2 px-3 py-5 sm:gap-4 sm:px-6">
      <Link href="/" aria-label="PayAI home" className="flex shrink-0 items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Logo size={32} />
        {/* Wordmark is decorative next to the mark; hidden below sm purely to
            buy back the ~44px that pushed the CTA off-screen. aria-label on
            the link keeps the accessible name intact either way. */}
        <span className="hidden text-sm font-semibold text-foreground sm:inline">PayAI</span>
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
              // py-3.5 gives a 44px target at every width. Not overridden per
              // breakpoint on purpose: a `sm:py-*` override loses to source
              // order in Tailwind (media queries add no specificity), and 44px
              // is a perfectly good nav height on desktop too.
              className={`${"fromMd" in l && l.fromMd ? "hidden md:inline-flex" : l.phoneHidden ? "hidden sm:inline-flex" : "inline-flex"} items-center whitespace-nowrap rounded-lg px-1.5 py-3.5 text-xs font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3 sm:text-sm ${
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
          href={`${APP_ORIGIN}/auth`}
          className="inline-flex items-center rounded-md bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
        >
          Launch PayAI
        </Link>
      </div>
    </header>
  );
}
