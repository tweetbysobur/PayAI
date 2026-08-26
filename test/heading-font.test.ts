import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Both the landing page's final CTA and /product's render their closing
 * heading in Montserrat, uppercase, while the rest of the site keeps its
 * default Jakarta type. Per direct review feedback (a screenshot with the
 * heading circled), that styling applies regardless of the heading's own
 * copy — the landing page's was later reworded ("Turn your intent into
 * on-chain actions.") while /product's kept the original, so this checks
 * each page's actual heading rather than assuming they share one string.
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
  for (const [name, src, heading] of [
    ["landing page", page, "Turn your intent into on-chain actions\\."],
    ["/product", product, "Start managing payments, not transactions\\."],
  ] as const) {
    it(`${name}: closing CTA heading is font-montserrat uppercase`, () => {
      const match = src.match(new RegExp(`<h2 className="([^"]*)">\\s*${heading}`));
      expect(match, `heading not found in ${name}`).toBeTruthy();
      expect(match![1]).toMatch(/\bfont-montserrat\b/);
      expect(match![1]).toMatch(/\buppercase\b/);
    });
  }
});
