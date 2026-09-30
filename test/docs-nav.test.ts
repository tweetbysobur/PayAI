import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DOCS_NAV } from "@/lib/docs/nav";

/**
 * A docs link that 404s is worse than no docs. The nav is the public map;
 * every href must have a page, and the pages must not revive the claims
 * the trust-hardening PR killed.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function pageFor(href: string): string {
  if (href === "/docs") return join(root, "app/docs/page.tsx");
  return join(root, "app", href.replace(/^\//, ""), "page.tsx");
}

describe("docs nav points at real pages", () => {
  for (const group of DOCS_NAV) {
    for (const item of group.items) {
      it(`${item.label} (${item.href}) exists`, () => {
        expect(existsSync(pageFor(item.href)), pageFor(item.href)).toBe(true);
      });
    }
  }
});

describe("docs copy stays honest", () => {
  const files = DOCS_NAV.flatMap((g) => g.items.map((i) => pageFor(i.href)));

  it("does not claim the application source is public", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/full source are public/i);
      expect(src, file).not.toMatch(/is public on GitHub/i);
      expect(src, file).not.toMatch(/open source/i);
    }
  });

  it("HTTP API and Telegram bot docs are backend-only, not public pages", () => {
    const hrefs = DOCS_NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain("/docs/api");
    expect(hrefs).not.toContain("/docs/telegram");
    expect(existsSync(join(root, "app/docs/api/page.tsx"))).toBe(false);
    expect(existsSync(join(root, "app/docs/telegram/page.tsx"))).toBe(false);
    expect(existsSync(join(root, "docs/backend/http-api.md"))).toBe(true);
    expect(existsSync(join(root, "docs/backend/telegram-bot.md"))).toBe(true);
  });

  it("the Telegram custody disclosure stays public on the Security page", () => {
    const src = readFileSync(join(root, "app/security/page.tsx"), "utf8");
    expect(src).toMatch(/custodial/i);
    expect(src).toMatch(/\/withdraw/);
  });

  it("fees docs state 0.25% and do not say \$0 platform fees", () => {
    const src = readFileSync(pageFor("/docs/fees"), "utf8");
    expect(src).toMatch(/0\.25%/);
    expect(src).not.toMatch(/charges \$0/);
  });

  it("SDK docs say it isn't a published package and name the documented actions", () => {
    const src = readFileSync(pageFor("/docs/sdk"), "utf8");
    expect(src).toMatch(/Not a published package/);
    expect(src).not.toMatch(/npm install|yarn add|pnpm add/i);
    for (const action of ["wrap 1 MON", "unwrap 1 WMON", "split 3 MON"]) {
      expect(src, action).toContain(action);
    }
    // Aave is deliberately not documented on the public SDK page, or as a
    // supported integration anywhere in the public docs.
    expect(src).not.toMatch(/aave/i);
    expect(src).not.toMatch(/aave-v3-monad/i);
    // The approval step of an ERC-20 split targets the token, not a listed
    // contract; the page must not claim otherwise.
    expect(src).toMatch(/A token approval goes to the token itself/);
    expect(src).not.toMatch(/Each action may only send transactions/);
    // Guarantees stay bounded: the page says what the checks do NOT cover.
    expect(src).toMatch(/What the checks do not cover/);
    expect(src).toMatch(/Right network/);
    // The orphan first SplitSettlement deploy must never be published.
    expect(src).not.toMatch(/0xfCD284AD855a0D1E0e1f1154C038D70cC33357dd/i);
  });

  it("no public docs page, nav, or sitemap documents Aave as an integration", () => {
    const surfaces = [
      ...files,
      join(root, "app/docs/page.tsx"),
      join(root, "lib/docs/nav.ts"),
      join(root, "app/sitemap.ts"),
      join(root, "lib/hosts.ts"),
    ];
    for (const file of surfaces) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/aave/i);
    }
  });

  it("footer lists Docs on the docs host", () => {
    const footer = readFileSync(join(root, "components/landing/SiteFooter.tsx"), "utf8");
    expect(footer).toMatch(/DOCS_ORIGIN/);
  });
});
