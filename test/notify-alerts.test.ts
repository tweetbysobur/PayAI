import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { alertKind, headline, newAlerts } from "@/lib/notify/alerts";

const H = "0x" + "ab".repeat(32);

describe("which notifications pop up", () => {
  it("a deposit is the celebration", () => {
    expect(alertKind({ decision: "deposit_received", at: 1, txHash: H })).toBe("deposit");
  });
  it("any transaction pops up as activity", () => {
    for (const d of ["executed", "withdrawal_completed", "refund_completed", "swap_completed"]) {
      expect(alertKind({ decision: d, at: 1, txHash: H }), d).toBe("activity");
    }
    expect(alertKind({ decision: "automation_executed", at: 1 })).toBe("activity");
  });
  it("failures get their own kind", () => {
    for (const d of ["error", "blocked", "refused", "needs_review", "automation_execution_failed", "automation_paused"]) {
      expect(alertKind({ decision: d, at: 1 }), d).toBe("failure");
    }
  });
  it("non-transaction notices stay in the bell only", () => {
    for (const d of ["wallet_connected", "wallet_disconnected", "support_ticket_submitted", "automation_upcoming_execution", "automation_created"]) {
      expect(alertKind({ decision: d, at: 1 }), d).toBeNull();
    }
  });
});

describe("only new ones, one card per batch", () => {
  const items = [
    { decision: "executed", at: 100, txHash: H },
    { decision: "deposit_received", at: 90, txHash: H },
    { decision: "wallet_connected", at: 120 },
    { decision: "executed", at: 50, txHash: H },
  ];
  it("ignores anything at or before the last announced time", () => {
    expect(newAlerts(items, 90).map((n) => n.at)).toEqual([100]);
    expect(newAlerts(items, 200)).toEqual([]);
  });
  it("a deposit in the batch wins, and the rest are counted", () => {
    const top = headline(newAlerts(items, 0))!;
    expect(top.kind).toBe("deposit");
    expect(top.more).toBe(2);
  });
  it("a failure outranks plain activity", () => {
    const top = headline(newAlerts([{ decision: "executed", at: 5, txHash: H }, { decision: "error", at: 4 }], 0))!;
    expect(top.kind).toBe("failure");
  });
});

describe("the pop-up and its sound", () => {
  const src = readFileSync("components/dashboard/ActivityAlert.tsx", "utf8");
  it("plays the matching sound and respects reduced motion for confetti", () => {
    expect(src).toMatch(/playNotificationSound\(top\.kind\)/);
    expect(src).toMatch(/useReducedMotion\(\)/);
  });
  it("never replays the past on a first visit", () => {
    expect(src).toMatch(/First time on this browser: start from the newest thing already in/);
    expect(src).not.toMatch(/seenAt\.current = Date\.now\(\)/);
  });
  it("the dashboard mounts it", () => {
    expect(readFileSync("app/dashboard/layout.tsx", "utf8")).toMatch(/<ActivityAlert /);
  });
});
