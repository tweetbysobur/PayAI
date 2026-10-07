import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Rate-limit coverage is a PROTOCOL, not a one-time cleanup: every API route
 * must either rate-limit itself or appear below with a written reason. A new
 * route can't quietly ship without that decision being made, and a decision
 * that stops being true fails here rather than in production.
 *
 * This exists because thirteen routes had drifted past the limiter unnoticed,
 * three of them expensive and unauthenticated. The worst was
 * /api/portfolio/discover: a 30-second function issuing up to 32 address-less
 * getLogs queries — the shape RPC providers charge most for — whose only
 * practical brake was a 5-minute cache that a later ?fresh=1 bypass then
 * removed. Nothing about that was visible in review; it was only ever
 * findable by enumerating the routes, which is exactly what this test does on
 * every run.
 *
 * Being on the exempt list is a claim about COST and BLAST RADIUS, not about
 * how much anyone trusts the caller.
 */

const API_DIR = join(__dirname, "..", "app", "api");

/** Route path -> why it is safe to serve unlimited. Keep the reason specific
 *  enough that a future reader can tell whether it still holds. */
const EXEMPT: Record<string, string> = {
  "auth/callback/[provider]/route.ts":
    "OAuth redirect target. The provider — not the user — controls the request rate, and a 429 here strands someone mid-sign-in with no way to retry. The code it carries is single-use and verified server-side.",
  "auth/session/route.ts":
    "Reads/clears the session cookie. No chain reads, no external calls, no DB fan-out — a request costs the same as serving a static file.",
  "cron/run-schedules/route.ts":
    "Gated on a bearer CRON_SECRET and refuses every request without it, which is a strictly tighter limit than any per-IP window. Rate-limiting it by IP would instead risk dropping real scheduled runs.",
  "health/route.ts":
    "Liveness probe. Throttling it makes the platform's own monitoring report a false outage.",
  "health/kv/route.ts":
    "Temporary operational probe. Fixed work per request (one SET/GET/DEL/GET on a 30s disposable key), no input, no user data, no chain access; a limiter would itself use the KV being probed. Remove this entry with the route.",
  "automation-config/route.ts":
    "Returns configured contract addresses read from env. Constant work per request, no chain or DB access.",
  "fees/route.ts":
    "Returns the current fee rate per feature, read from env. Constant work per request, no chain or DB access — same shape as automation-config/route.ts above.",
  "wallet-service/status/route.ts":
    "Reports whether the wallet service is configured. Constant work per request.",
  "platform-stats/route.ts":
    "Aggregate platform activity from the store, already cached in the analytics layer. DB-only — no RPC, so no external per-request cost.",
  "analytics/route.ts":
    "Tenant- and sender-scoped store reads. DB-only, bounded by the scoping, and it exposes nothing the caller can't already see about their own wallet.",
  "automation-events/route.ts":
    "Tenant-scoped event list from the store. DB-only, no RPC.",
  "assistant/context/route.ts":
    "Fans out to several store reads, but all of them are DB-only and wallet-scoped — no RPC, no external provider, and no per-request cost beyond the database.",
};

function routeFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...routeFiles(join(dir, entry.name), rel));
    else if (entry.name === "route.ts") out.push(rel);
  }
  return out;
}

const ALL_ROUTES = routeFiles(API_DIR);

describe("every API route either rate-limits or is explicitly exempt", () => {
  it("finds the route files at all (a broken glob would make this suite vacuously pass)", () => {
    expect(ALL_ROUTES.length).toBeGreaterThan(20);
  });

  it.each(ALL_ROUTES)("%s", (route) => {
    const source = readFileSync(join(API_DIR, route), "utf8");
    if (source.includes("rateLimited(")) return;
    expect(
      EXEMPT[route],
      `${route} does not call rateLimited(). Either add a limit, or add an entry to EXEMPT in this file explaining why serving it unlimited is safe.`,
    ).toBeTruthy();
  });

  it("has no stale exemptions -- a route that was removed, or that now limits itself, must not keep a standing waiver", () => {
    for (const [route, reason] of Object.entries(EXEMPT)) {
      expect(ALL_ROUTES, `${route} is exempt but no longer exists`).toContain(route);
      const source = readFileSync(join(API_DIR, route), "utf8");
      expect(
        source.includes("rateLimited("),
        `${route} now rate-limits itself -- remove its EXEMPT entry so the list keeps meaning something`,
      ).toBe(false);
      expect(reason.length, `${route}'s exemption needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});

/**
 * The specific routes the sweep found unlimited AND expensive. Pinned by name
 * because "it's rate-limited" is the whole mitigation for each — there is no
 * auth gate behind them to fall back on.
 */
describe("the expensive unauthenticated read routes stay limited", () => {
  it.each([
    ["portfolio/discover/route.ts", "up to 32 address-less getLogs in a 30s function"],
    ["prices/route.ts", "up to 150 quoter calls per request on cache-missing addresses"],
    ["tokens/route.ts", "arbitrary address resolution into a permanent, never-reclaimed cache"],
  ])("%s is rate-limited (%s)", (route) => {
    const source = readFileSync(join(API_DIR, route), "utf8");
    expect(source).toContain("rateLimited(");
    expect(EXEMPT[route], "this route must never be moved onto the exempt list").toBeUndefined();
  });

  it("the ?fresh=1 cache bypass carries its own wallet-keyed limit, not just the per-IP one", () => {
    const source = readFileSync(join(API_DIR, "portfolio/discover/route.ts"), "utf8");
    // The IP bucket alone leaves the forced rescan open to anyone rotating
    // IPs at a single wallet; the bypass is only bounded if it is ALSO keyed
    // on the address it forces work for.
    expect(source).toContain("discover-fresh");
    expect(source).toMatch(/subject:\s*key/);
  });
});
