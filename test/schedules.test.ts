import { describe, it, expect } from "vitest";
import { createSchedule, recordRun, getSchedule, updateSchedule, advanceRun } from "@/lib/platform/schedules";

// These exercise the single most important reliability decision in the
// scheduled-payments feature: what happens to the schedule after a run,
// depending on WHY it did or didn't succeed. Getting this wrong either
// silently skips a payment the user was relying on, or retries a payment
// that will never clear, forever.

function makeSchedule(overrides: Partial<Parameters<typeof createSchedule>[1]> = {}) {
  return createSchedule("merchant-1", {
    amount: 10,
    token: "USDC",
    recipient: "0x1234567890abcdef1234567890abcdef12345678",
    cadence: "weekly",
    nextRun: Date.now() - 1000, // already due
    ...overrides,
  });
}

describe("advanceRun", () => {
  it("returns null for a one-off (it should complete, not repeat)", () => {
    expect(advanceRun(Date.now(), "once")).toBeNull();
  });
  it("advances daily/weekly/monthly forward", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(advanceRun(now, "daily")).toBe(Date.UTC(2026, 0, 2));
    expect(advanceRun(now, "weekly")).toBe(Date.UTC(2026, 0, 8));
    expect(advanceRun(now, "monthly")).toBe(Date.UTC(2026, 1, 1));
  });
});

describe("recordRun — executed", () => {
  it("advances a recurring schedule's nextRun and stays upcoming", async () => {
    const s = await makeSchedule();
    const before = s.nextRun;
    const after = await recordRun(s.id, { at: Date.now(), decision: "executed" });
    expect(after!.status).toBe("upcoming");
    expect(after!.nextRun).toBeGreaterThan(before);
    expect(after!.runsCompleted).toBe(1);
    expect(after!.failureCount).toBe(0);
  });

  it("completes a one-off schedule after its single run", async () => {
    const s = await makeSchedule({ cadence: "once" });
    const after = await recordRun(s.id, { at: Date.now(), decision: "executed" });
    expect(after!.status).toBe("completed");
  });

  it("completes a recurring schedule once its after_count end condition is reached", async () => {
    const s = await makeSchedule({ endCondition: { type: "after_count", totalRuns: 2 } });
    const r1 = await recordRun(s.id, { at: Date.now(), decision: "executed" });
    expect(r1!.status).toBe("upcoming");
    const r2 = await recordRun(s.id, { at: Date.now(), decision: "executed" });
    expect(r2!.status).toBe("completed");
    expect(r2!.runsCompleted).toBe(2);
  });

  it("resets failureCount to 0 after a successful run following prior errors", async () => {
    const s = await makeSchedule();
    await recordRun(s.id, { at: Date.now(), decision: "error", detail: "RPC timeout" });
    const after = await recordRun(s.id, { at: Date.now(), decision: "executed" });
    expect(after!.failureCount).toBe(0);
    expect(after!.lastError).toBeNull();
  });
});

describe("recordRun — hard compliance outcomes are terminal", () => {
  it("marks the schedule 'failed' immediately on a compliance block, without advancing nextRun", async () => {
    const s = await makeSchedule();
    const before = s.nextRun;
    const after = await recordRun(s.id, { at: Date.now(), decision: "blocked", detail: "Recipient sanctioned." });
    expect(after!.status).toBe("failed");
    expect(after!.nextRun).toBe(before); // never advanced past the blocked occurrence
    expect(after!.lastError).toMatch(/sanctioned/i);
  });

  it("marks the schedule 'failed' on needs_review too — there's no unattended review path", async () => {
    const s = await makeSchedule();
    const after = await recordRun(s.id, { at: Date.now(), decision: "needs_review", detail: "High risk." });
    expect(after!.status).toBe("failed");
  });
});

describe("recordRun — execution errors are retried with a bound", () => {
  it("retries a transient error without advancing to the next cadence period", async () => {
    const s = await makeSchedule();
    const after = await recordRun(s.id, { at: Date.now(), decision: "error", detail: "RPC unreachable" });
    expect(after!.status).toBe("upcoming");
    expect(after!.failureCount).toBe(1);
    // Retried soon, but NOT left in the past (which would hammer immediately).
    expect(after!.nextRun).toBeGreaterThan(Date.now());
  });

  it("auto-pauses to 'failed' after 3 consecutive errors instead of retrying forever", async () => {
    const s = await makeSchedule();
    await recordRun(s.id, { at: Date.now(), decision: "error", detail: "e1" });
    await recordRun(s.id, { at: Date.now(), decision: "error", detail: "e2" });
    const third = await recordRun(s.id, { at: Date.now(), decision: "error", detail: "e3" });
    expect(third!.failureCount).toBe(3);
    expect(third!.status).toBe("failed");
  });
});

describe("updateSchedule", () => {
  it("edits an upcoming schedule's amount and cadence", async () => {
    const s = await makeSchedule();
    const edited = await updateSchedule("merchant-1", s.id, { amount: 25, cadence: "monthly" });
    expect(edited!.amount).toBe(25);
    expect(edited!.cadence).toBe("monthly");
  });

  it("refuses to edit a schedule that already completed", async () => {
    const s = await makeSchedule({ cadence: "once" });
    await recordRun(s.id, { at: Date.now(), decision: "executed" });
    const edited = await updateSchedule("merchant-1", s.id, { amount: 99 });
    expect(edited).toBeNull();
  });

  it("refuses to edit a schedule owned by a different wallet on the shared tenant", async () => {
    const s = await makeSchedule({ sender: "0xaaaa000000000000000000000000000000000001" });
    const edited = await updateSchedule("merchant-1", s.id, { amount: 99 }, { sender: "0xbbbb000000000000000000000000000000000002" });
    expect(edited).toBeNull();
    const stillOriginal = await getSchedule(s.id);
    expect(stillOriginal!.amount).toBe(s.amount);
  });
});
