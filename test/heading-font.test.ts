import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * /product's closing heading renders in Montserrat, uppercase. (The landing
 * page's did too until the landing redesign moved the whole page to one
 * typeface, Geist; that is checked at the bottom.) Originally both did, while the rest of the site keeps its
 * default Jakarta type. Per direct review feedback (a screenshot with the
 * heading circled), that styling applies regardless of the heading's own
 * copy — both have since been reworded independently ("Turn your intent into
 * on-chain actions." and "Describe it. Review it. Approve it."), so this
 * checks each page's actual heading rather than assuming they share one
 * string. Update the expected copy here when a heading is deliberately
 * reworded; the assertion that matters is the font/case, not the words.
 *
 * Montserrat is opt-in only (`font-montserrat`), not a change to
 * `--font-sans` — so this covers the two headings without silently
 * retyping everything else on the page.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const layout = read("../app/layout.tsx");
const globalsCss = read("../app/globals.css");
const page = read("../app/page.tsx");
const product = read("../app/product/page.tsx");

describe("Montserrat is loaded and opt-in only", () => {
  it("self-hosts Montserrat via next/font, the same way as the default typeface", () => {
    expect(layout).toMatch(/Montserrat\s*}\s*from\s*"next\/font\/google"/);
    expect(layout).toMatch(/variable:\s*"--font-montserrat"/);
  });

  it("does not replace the site's default --font-sans", () => {
    // Retyping the whole site was never the ask — only these two headings.
    expect(globalsCss).toMatch(/--font-sans:\s*var\(--font-jakarta\)/);
    expect(globalsCss).toMatch(/--font-montserrat:\s*var\(--font-montserrat\)/);
  });
});

describe("/product's closing-CTA heading uses Montserrat, uppercase", () => {
  for (const [name, src, heading] of [
    ["/product", product, "Describe it\\. Review it\\. Approve it\\."],
  ] as const) {
    it(`${name}: closing CTA heading is font-montserrat uppercase`, () => {
      const match = src.match(new RegExp(`<h2 className="([^"]*)">\\s*${heading}`));
      expect(match, `heading not found in ${name}`).toBeTruthy();
      expect(match![1]).toMatch(/\bfont-montserrat\b/);
      expect(match![1]).toMatch(/\buppercase\b/);
    });
  }
});

describe("the landing page's closing heading follows the landing typeface", () => {
  // The landing redesign sets one typeface (Geist) across the whole page, so
  // its closing heading no longer opts into Montserrat.
  it("is not Montserrat or uppercase, and the page sets Geist on <main>", () => {
    const match = page.match(/<h2 className="([^"]*)">\s*Make intent\. Get your onchain execution done/);
    expect(match, "heading not found on the landing page").toBeTruthy();
    expect(match![1]).not.toMatch(/\bfont-montserrat\b|\buppercase\b/);
    expect(page).toMatch(/<main\s+className=\{`\$\{geist\.className\}/);
  });
});
