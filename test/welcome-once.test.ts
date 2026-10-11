import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localDay, shouldShowWelcome } from "@/lib/hooks/useOnboarding";

/**
 * The welcome shows at the first visit of each day — first-time users, and
 * anyone back after a day or more away — and stays closed for the rest of
 * that day once finished or skipped. Ask PayAI's "how to ask" points show
 * once, ever, and carry no worked examples.
 */
describe("welcome: first visit each day", () => {
  it("first time ever → shown", () => expect(shouldShowWelcome(null, "2026-10-11")).toBe(true));
  it("already shown today → not again", () => expect(shouldShowWelcome("2026-10-11", "2026-10-11")).toBe(false));
  it("last shown yesterday → shown", () => expect(shouldShowWelcome("2026-10-10", "2026-10-11")).toBe(true));
  it("away for days → shown", () => expect(shouldShowWelcome("2026-10-01", "2026-10-11")).toBe(true));
  it("localDay is the local calendar date", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

const code = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("the welcome itself", () => {
  const src = code("components/onboarding/OnboardingFlow.tsx");
  it("has the four steps", () => {
    expect(src).toMatch(/const STEPS = \["Welcome", "Your wallet", "Automations", "Get started"\] as const;/);
  });
  it("names the live network, never Testnet, and keeps the automation nuance", () => {
    expect(src).not.toMatch(/Testnet/i);
    expect(src).toMatch(/MONAD_CHAIN_NAME/);
    expect(src).toMatch(/capped agent wallet/);
  });
  it("is points, not worked examples", () => {
    expect(src).not.toMatch(/\b\d+(\.\d+)?\s*(USDC|MON)\b|\.nad\b/);
  });
  it("the tour no longer says Rooms isn't available", () => {
    expect(code("components/onboarding/TourOverlay.tsx")).not.toMatch(/isn't available yet/);
  });
});

describe("Ask PayAI's empty chat", () => {
  const src = code("components/ask/AskEmptyState.tsx");
  const welcome = src.slice(src.indexOf("export function AskEmptyState("));
  it("is just the heading and the one describe line", () => {
    expect(welcome).toContain("Turn a sentence into onchain execution.");
    expect(welcome).toContain("Describe what you want done on Monad. PayAI turns it into a plan you review before anything runs.");
    expect(welcome).not.toMatch(/How to ask|<ol|<button|<a |\.nad\b|\b\d+\s*(USDC|MON)\b/);
  });
});
