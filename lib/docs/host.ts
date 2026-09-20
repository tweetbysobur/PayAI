/**
 * docs.usepayai.xyz is the same Next app, not a second project.
 * A CNAME is free once you already own usepayai.xyz.
 *
 * Canonical nav hrefs stay `/docs/...` and `/security`. On the docs host,
 * those become `/` and `/getting-started` in the URL bar via middleware.
 */

export const APP_ORIGIN = "https://usepayai.xyz";
export const DOCS_HOST = "docs.usepayai.xyz";

const DOCS_HOSTS = new Set([DOCS_HOST, "docs.localhost"]);

export function isDocsHost(host: string | null | undefined): boolean {
  const h = (host || "").split(":")[0].toLowerCase();
  return DOCS_HOSTS.has(h);
}

/** Product routes that do not belong on the docs host — send them home. */
export const APP_PATH_PREFIXES = ["/dashboard", "/auth", "/connect", "/pay", "/product", "/how-it-works"];

export function isAppPath(pathname: string): boolean {
  return APP_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * URL-bar path on the docs host for a canonical href (`/docs` → `/`).
 * Legal pages (`/security`) are unchanged.
 */
export function publicDocsPath(href: string, onDocsHost: boolean): string {
  if (!onDocsHost) return href;
  if (href === "/docs") return "/";
  if (href.startsWith("/docs/")) return href.slice("/docs".length);
  return href;
}

/**
 * Map a URL-bar pathname back to the canonical `/docs/...` href used in nav.
 * `/` and `/getting-started` on the docs host, `/docs` on the app host.
 */
export function canonicalDocsPath(pathname: string): string {
  if (pathname === "/") return "/docs";
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return pathname;
  const first = pathname.split("/").filter(Boolean)[0];
  if (first && DOCS_SLUGS.has(first)) return `/docs/${pathname.replace(/^\//, "")}`;
  return pathname;
}

const DOCS_SLUGS = new Set([
  "getting-started",
  "payments",
  "automations",
  "fees",
  "ask",
  "contracts",
  "api",
  "telegram",
]);

export function isDocsSlugPath(pathname: string): boolean {
  const first = pathname.split("/").filter(Boolean)[0];
  return Boolean(first && DOCS_SLUGS.has(first));
}

export { DOCS_SLUGS };
