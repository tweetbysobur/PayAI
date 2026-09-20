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

  it("telegram docs call the bot custodial", () => {
    const src = readFileSync(pageFor("/docs/telegram"), "utf8");
    expect(src).toMatch(/custodial/i);
    expect(src).toMatch(/\/withdraw/);
  });

  it("fees docs state 0.25% and do not say \$0 platform fees", () => {
    const src = readFileSync(pageFor("/docs/fees"), "utf8");
    expect(src).toMatch(/0\.25%/);
    expect(src).not.toMatch(/charges \$0/);
  });

  it("footer lists Docs", () => {
    const footer = readFileSync(join(root, "components/landing/SiteFooter.tsx"), "utf8");
    expect(footer).toMatch(/href: "\/docs"/);
  });
});
