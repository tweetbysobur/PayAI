import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Finishing the welcome tour must open a NEW Ask conversation — reopening
 *  the last saved one showed stale replies as if they were current. */
describe("welcome tour → Ask", () => {
  const tour = readFileSync("components/onboarding/OnboardingFlow.tsx", "utf8");
  const ask = readFileSync("app/dashboard/ask/page.tsx", "utf8");
  it("clears the active conversation and asks for a new one", () => {
    expect(tour).toMatch(/setActiveConversationPointer\([^)]*\), null\)/);
    expect(tour).toContain('router.push("/dashboard/ask?new=1")');
  });
  it("the Ask page honours ?new=1 once and removes it", () => {
    expect(ask).toMatch(/searchParams\.get\("new"\) !== "1"/);
    expect(ask).toMatch(/newConversation\(\);\s*url\.searchParams\.delete\("new"\)/);
  });
});
