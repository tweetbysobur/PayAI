/**
 * Docs URL helpers. Host constants live in lib/hosts.ts so marketing / app /
 * docs stay one mapping.
 */

export {
  APP_ORIGIN,
  DOCS_HOST,
  DOCS_ORIGIN,
  DOCS_SLUGS,
  canonicalDocsPath,
  isAppPath,
  isDocsHost,
  isDocsSlugPath,
  publicDocsPath,
} from "@/lib/hosts";

/** @deprecated Use isAppPath from lib/hosts — product/how-it-works are marketing. */
export const APP_PATH_PREFIXES = ["/dashboard", "/auth", "/connect", "/pay", "/product", "/how-it-works"];
