import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The trade preview card warns "This quote is more than a minute old — prices
 * may have moved" once a quote passes its staleness window. That warning was
 * gated on `Date.now() - d.quotedAt > 60_000` evaluated during render — a
 * one-shot snapshot, not a live value.
 *
 * The card lives in the Ask PayAI chat transcript, which can sit untouched on
 * screen indefinitely. Nothing re-renders it on its own, so a quote that went
 * stale minutes ago kept presenting itself as fresh, and the user could act on
 * it having never been warned. In a trading flow that is exactly the moment
 * the warning exists for.
 *
 * The fix holds staleness in state and schedules a single timer for the precise
 * moment the quote crosses the window. These assertions are source-level (this
 * repo has no React renderer in its test setup — see wallets-hero-card.test.ts
 * for the same approach), and they pin the properties that actually matter:
 * the initial value is still computed from the real quote time, a timer flips
 * it, and it is never recomputed inline during render again.
 */

const src = readFileSync(new URL("../components/ask/OperationCard.tsx", import.meta.url), "utf8");

describe("the trade preview's stale-quote warning is live, not a render-time snapshot", () => {
  it("no longer derives isStale from a bare Date.now() comparison during render", () => {
    expect(src).not.toMatch(/const isStale = Date\.now\(\) - d\.quotedAt/);
  });

  it("seeds isStale from the quote's real age, so an already-stale quote warns immediately", () => {
    // Lazy useState initializer — an old quote restored into the transcript
    // must warn on its very first paint, not after a timer tick.
    expect(src).toMatch(/useState\(\(\) => Date\.now\(\) - d\.quotedAt > QUOTE_STALE_AFTER_MS\)/);
  });

  it("schedules a timer that flips a still-fresh quote to stale", () => {
    expect(src).toMatch(/setTimeout\(\(\) => setIsStale\(true\)/);
  });

  it("clears the timer on unmount rather than leaking it per rendered card", () => {
    expect(src).toMatch(/return \(\) => clearTimeout\(t\)/);
  });

  it("stops timing once stale — a quote only ever goes stale, never back to fresh", () => {
    expect(src).toMatch(/if \(isStale\) return;/);
  });

  it("keeps the one-minute window the rest of the app already uses", () => {
    expect(src).toMatch(/const QUOTE_STALE_AFTER_MS = 60_000;/);
  });

  it("still actually renders the warning off isStale", () => {
    expect(src).toMatch(/\{isStale && \(/);
    expect(src).toMatch(/This quote is more than a minute old/);
  });
});
