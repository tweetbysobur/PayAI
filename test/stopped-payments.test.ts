import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECENT_STOPPED_MS, STOPPED_LABEL, stoppedNotice } from "@/lib/hooks/stoppedPayments";

/**
 * A "needs_review" record is a payment PayAI's risk check stopped before
 * anything was sent (lib/automation/execute.ts records it and moves nothing;
 * lib/platform/schedules.ts says there is no manual-review step). The
 * dashboard called these "held for review" and counted every one in history
 * forever: it promised a review that never comes, implied money was waiting
 * somewhere, and the warning could never clear.
 */
const now = Date.UTC(2026, 9, 11, 12);
const row = (decision: string, ageMs: number) => ({ decision, at: now - ageMs });

describe("stoppedNotice", () => {
  it("nothing stopped → no notice", () => {
    expect(stoppedNotice([row("executed", 1000), row("blocked", 1000)], now)).toBeNull();
  });
  it("says what happened: stopped, nothing sent — never 'held' or 'review'", () => {
    const n = stoppedNotice([row("needs_review", 1000), row("needs_review", 2000)], now)!;
    expect(n.count).toBe(2);
    expect(n.title).toBe("2 payments were stopped by the risk check");
    expect(n.detail).toMatch(/nothing was sent/i);
    expect(`${n.title} ${n.detail}`).not.toMatch(/held|in review|being reviewed|pending/i);
    expect(stoppedNotice([row("needs_review", 1000)], now)!.title).toBe("1 payment was stopped by the risk check");
  });
  it("only recent ones count, so the warning clears on its own", () => {
    expect(stoppedNotice([row("needs_review", RECENT_STOPPED_MS + 1)], now)).toBeNull();
    expect(stoppedNotice([row("needs_review", RECENT_STOPPED_MS - 1), row("needs_review", RECENT_STOPPED_MS * 3)], now)!.count).toBe(1);
  });
  it("links to exactly those rows in history", () => {
    expect(stoppedNotice([row("needs_review", 1)], now)!.href).toBe("/dashboard/transactions?status=needs_review");
  });
});

describe("no screen calls a stopped payment pending or in review", () => {
  const code = (p: string) => readFileSync(join(__dirname, "..", p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it.each([
    "app/dashboard/page.tsx", "app/dashboard/transactions/page.tsx", "lib/hooks/useNotifications.ts",
    "app/dashboard/automations/page.tsx", "lib/ask/sendPayment/orchestrator.ts",
  ])("%s", (f) => {
    const src = code(f);
    expect(src).not.toMatch(/held for review|In review|needs review|Needs review|needs manual review/);
  });
  it("the activity feed doesn't mark it pending", () => {
    expect(code("lib/hooks/useActivity.ts")).not.toMatch(/needs_review"\)\s*return\s*"pending"/);
  });
  it("labels share one wording", () => {
    expect(STOPPED_LABEL).toBe("Stopped");
  });
  it("history opens filtered by ?status=", () => {
    expect(code("app/dashboard/transactions/page.tsx")).toMatch(/searchParams\.get\("status"\)/);
  });
});
