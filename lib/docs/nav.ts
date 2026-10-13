/**
 * Public documentation + legal navigation.
 *
 * One list, consumed by the docs chrome and by the test that asserts every
 * href has a real page. Adding a link without a page is how docs rot; the
 * test fails the build when that happens.
 */

import { canonicalDocsPath } from "@/lib/docs/host";

export const DOCS_UPDATED = "13 October 2026";

export interface DocsNavItem {
  href: string;
  label: string;
  /** Only the Overview item is an exact-path match; nested routes would
   *  otherwise all light up when sitting on `/docs`. */
  exact?: boolean;
}

export interface DocsNavGroup {
  title: string;
  items: DocsNavItem[];
}

export const DOCS_NAV: DocsNavGroup[] = [
  {
    title: "Product",
    items: [
      { href: "/docs", label: "Overview", exact: true },
      { href: "/docs/getting-started", label: "Getting started" },
      { href: "/docs/payments", label: "Payments" },
      { href: "/docs/trading", label: "Trading" },
      { href: "/docs/automations", label: "Automations" },
      { href: "/docs/fees", label: "Fees" },
      { href: "/docs/ask", label: "Ask PayAI" },
    ],
  },
  {
    title: "Developers",
    items: [
      { href: "/docs/sdk", label: "PayAI SDK" },
      { href: "/docs/contracts", label: "Contracts" },
    ],
  },
  {
    title: "Legal",
    items: [
      { href: "/security", label: "Security" },
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
];

export function docsNavIsActive(href: string, pathname: string, exact?: boolean): boolean {
  const path = canonicalDocsPath(pathname);
  if (exact) return path === href;
  return path === href || path.startsWith(`${href}/`);
}
