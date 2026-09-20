/**
 * One Vercel project, three hostnames. Adding a subdomain is free.
 *
 *   usepayai.xyz        marketing
 *   app.usepayai.xyz    the product
 *   docs.usepayai.xyz   documentation
 *
 * Localhost and Vercel preview URLs stay unsplit so `npm run dev` and PR
 * previews keep working without extra DNS.
 */

export const MARKETING_HOST = "usepayai.xyz";
export const APP_HOST = "app.usepayai.xyz";
export const DOCS_HOST = "docs.usepayai.xyz";

export const MARKETING_ORIGIN = `https://${MARKETING_HOST}`;
export const APP_ORIGIN = `https://${APP_HOST}`;
export const DOCS_ORIGIN = `https://${DOCS_HOST}`;

export function hostnameOf(host: string | null | undefined): string {
  return (host || "").split(":")[0].toLowerCase();
}

export type HostKind = "marketing" | "app" | "docs" | "unsplit";

export function hostKind(host: string | null | undefined): HostKind {
  const h = hostnameOf(host);
  if (h === DOCS_HOST || h === "docs.localhost") return "docs";
  if (h === APP_HOST || h === "app.localhost") return "app";
  if (h === MARKETING_HOST || h === `www.${MARKETING_HOST}`) return "marketing";
  return "unsplit";
}

export const APP_PATH_PREFIXES = ["/dashboard", "/auth", "/connect", "/pay"] as const;

export function isAppPath(pathname: string): boolean {
  return APP_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function isMarketingPath(pathname: string): boolean {
  return pathname === "/product" || pathname === "/how-it-works";
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

export { DOCS_SLUGS };

export function isDocsSlugPath(pathname: string): boolean {
  const first = pathname.split("/").filter(Boolean)[0];
  return Boolean(first && DOCS_SLUGS.has(first));
}

export function isDocsHost(host: string | null | undefined): boolean {
  return hostKind(host) === "docs";
}

export function publicDocsPath(href: string, onDocsHost: boolean): string {
  if (!onDocsHost) return href;
  if (href === "/docs") return "/";
  if (href.startsWith("/docs/")) return href.slice("/docs".length);
  return href;
}

export function canonicalDocsPath(pathname: string): string {
  if (pathname === "/") return "/docs";
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return pathname;
  const first = pathname.split("/").filter(Boolean)[0];
  if (first && DOCS_SLUGS.has(first)) return `/docs/${pathname.replace(/^\//, "")}`;
  return pathname;
}

/** Passkeys created on usepayai.xyz must keep working on app.usepayai.xyz. */
export function passkeyRpId(hostname: string): string {
  const h = hostnameOf(hostname);
  if (h === MARKETING_HOST || h.endsWith(`.${MARKETING_HOST}`)) return MARKETING_HOST;
  return h;
}

export function cookieDomain(host: string | null | undefined): string | undefined {
  const h = hostnameOf(host);
  if (h === MARKETING_HOST || h.endsWith(`.${MARKETING_HOST}`)) return `.${MARKETING_HOST}`;
  return undefined;
}

export type HostAction =
  | { type: "next" }
  | { type: "redirect"; origin: string; pathname: string }
  | { type: "rewrite"; pathname: string };

export function hostAction(kind: HostKind, pathname: string): HostAction {
  if (kind === "unsplit") return { type: "next" };

  if (kind === "docs") {
    if (isAppPath(pathname)) return { type: "redirect", origin: APP_ORIGIN, pathname };
    if (isMarketingPath(pathname)) return { type: "redirect", origin: MARKETING_ORIGIN, pathname };
    if (pathname === "/docs" || pathname === "/docs/") return { type: "redirect", origin: DOCS_ORIGIN, pathname: "/" };
    if (pathname.startsWith("/docs/")) {
      return { type: "redirect", origin: DOCS_ORIGIN, pathname: pathname.slice("/docs".length) };
    }
    if (pathname === "/") return { type: "rewrite", pathname: "/docs" };
    if (isDocsSlugPath(pathname)) return { type: "rewrite", pathname: `/docs${pathname}` };
    return { type: "next" };
  }

  if (kind === "app") {
    if (pathname === "/") return { type: "redirect", origin: APP_ORIGIN, pathname: "/dashboard" };
    if (pathname === "/docs" || pathname.startsWith("/docs/")) {
      return { type: "redirect", origin: DOCS_ORIGIN, pathname: publicDocsPath(pathname, true) };
    }
    if (isDocsSlugPath(pathname)) return { type: "redirect", origin: DOCS_ORIGIN, pathname };
    if (isMarketingPath(pathname)) return { type: "redirect", origin: MARKETING_ORIGIN, pathname };
    return { type: "next" };
  }

  // marketing
  if (isAppPath(pathname)) return { type: "redirect", origin: APP_ORIGIN, pathname };
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    return { type: "redirect", origin: DOCS_ORIGIN, pathname: publicDocsPath(pathname, true) };
  }
  return { type: "next" };
}
