"use client";

import { useSyncExternalStore } from "react";
import { hostKind, MARKETING_ORIGIN } from "@/lib/hosts";

/**
 * Where the PayAI logo goes: the landing page.
 *
 * On app.usepayai.xyz "/" redirects to /dashboard, and on docs.usepayai.xyz
 * it is the docs home — so on those hosts the landing page must be named by
 * its full origin. Everywhere else (the landing site itself, local
 * development) "/" is the landing page.
 */
export function landingHref(hostname: string): string {
  const kind = hostKind(hostname);
  return kind === "app" || kind === "docs" ? `${MARKETING_ORIGIN}/` : "/";
}

const noop = () => () => {};

/** landingHref for this page's host. Renders "/" on the server and swaps in
 *  the right value after hydration without a mismatch. */
export function useLandingHref(): string {
  return useSyncExternalStore(noop, () => landingHref(window.location.hostname), () => "/");
}
