import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatVolumeAmount } from "../components/TokenLogo";

/**
 * The volume metric is the one figure on the landing page that has no fixed
 * width: it grows with the product, it holds more than one currency, and it
 * lives in a one-third column. Rendering it on a single line put "3,628.11
 * MON · 141.7 USDC" straight across the card beside it on a phone.
 *
 * These cover the two rules that keep it inside its box — the number gives
 * way before the layout does, and the row is allowed to shrink at all.
 */

const source = readFileSync(new URL("../components/TokenLogo.tsx", import.meta.url), "utf8");

describe("volume amount formatting", () => {
  it("keeps small totals exact", () => {
    // Early volume is the number a visitor judges the platform by. Rounding
    // 141.7 to "142" to save four pixels is not a trade worth making.
    expect(formatVolumeAmount(141.7)).toBe("141.7");
    expect(formatVolumeAmount(3628.11)).toBe("3,628.11");
  });

  it("caps at two decimals rather than printing float noise", () => {
    expect(formatVolumeAmount(0.1 + 0.2)).toBe("0.3");
    expect(formatVolumeAmount(12.3456)).toBe("12.35");
  });

  it("goes compact once the digits would outgrow the card", () => {
    expect(formatVolumeAmount(12_400)).toBe("12.4K");
    expect(formatVolumeAmount(2_500_000)).toBe("2.5M");
  });

  it("switches exactly at 10,000, not before", () => {
    // The boundary is the whole point: one below stays exact, one at the
    // threshold compacts. An off-by-one here silently rounds real totals.
    expect(formatVolumeAmount(9_999.99)).toBe("9,999.99");
    expect(formatVolumeAmount(10_000)).toBe("10K");
  });

  it("renders zero and tiny dust without inventing precision", () => {
    expect(formatVolumeAmount(0)).toBe("0");
    expect(formatVolumeAmount(0.004)).toBe("0");
  });
});

describe("volume rows cannot escape their card", () => {
  it("lets the number shrink while the logo and symbol hold their size", () => {
    // `min-w-0` is what makes truncate possible at all — a flex child's
    // default min-width is its content, so without it the row simply widens
    // and pushes out of the card instead of ellipsing.
    expect(source).toMatch(/flex min-w-0 items-center/);
    expect(source).toMatch(/truncate tabular-nums/);
    // The logo and the symbol are the parts that must never be clipped.
    expect(source).toMatch(/<TokenLogo[^>]*className="shrink-0"/);
    expect(source).toMatch(/shrink-0 text-\[10px\][^"]*">\{token\}/);
  });

  it("no longer ships the one-line variant that caused the overflow", () => {
    // Deleted rather than deprecated: an exported component that overflows in
    // a narrow container will eventually be picked up by a narrow container.
    expect(source).not.toMatch(/export function VolumeInline/);
  });

  it("never blends currencies into a single total", () => {
    // 1 MON + 1 USDC is not 2 of anything. One row per token, always.
    expect(source).toMatch(/Object\.entries\(byToken\)\.filter\(\(\[, v\]\) => v > 0\)/);
    expect(source).not.toMatch(/reduce.*\+.*v.*0\)/);
  });
});

describe("the landing showcase's stat grid", () => {
  const showcase = readFileSync(new URL("../components/landing/DashboardShowcase.tsx", import.meta.url), "utf8");

  it("gives its grid columns a min-width of 0", () => {
    // Without this the grid track widens to fit the content and the overflow
    // just moves somewhere else — the row of cards stops being three equal
    // thirds. This is the actual fix; truncate alone would not have done it.
    expect(showcase).toMatch(/min-w-0 rounded-xl/);
  });

  it("caps the volume card at two token rows", () => {
    // A third asset would make one card taller than the two beside it.
    expect(showcase).toMatch(/<VolumeStack[^/]*max=\{2\}/);
  });

  it("still shows an em dash rather than a zero when there is no volume", () => {
    // A fresh environment has no settled volume. "0" would be a claim; "—"
    // is the absence of one.
    expect(showcase).toMatch(/hasVolume[\s\S]{0,400}—/);
  });
});
