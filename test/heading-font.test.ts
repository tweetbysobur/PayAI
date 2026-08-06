import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * "Start managing payments, not transactions." appears twice — the landing
 * page's final CTA and /product's. Per direct review feedback (a screenshot
 * with the heading circled), both should render in Montserrat, uppercase,
 * while the rest of the site keeps its default Jakarta type.
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

describe("both closing-CTA headings use Montserrat, uppercase", () => {
  for (const [name, src] of [["landing page", page], ["/product", product]] as const) {
    it(`${name}: "Start managing payments, not transactions." is font-montserrat uppercase`, () => {
      const match = src.match(/<h2 className="([^"]*)">\s*Start managing payments, not transactions\./);
      expect(match, `heading not found in ${name}`).toBeTruthy();
      expect(match![1]).toMatch(/\bfont-montserrat\b/);
      expect(match![1]).toMatch(/\buppercase\b/);
    });
  }
});
