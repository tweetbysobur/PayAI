import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Mini Sprint Part 1's "TEST MODE": simulate each named failure scenario and
 * verify the refund system behaves correctly in every one.
 *
 * Deliberately implemented as an automated test suite, NOT a live toggle
 * reachable from the deployed app. A "simulate a failure on a real
 * automation" button in production, against real contracts and real user
 * funds, is exactly the kind of feature that turns a testing convenience
 * into a fund-safety liability (an attacker — or a curious user — could use
 * it to force refund attempts, race conditions, or unexpected states on
 * real money). Running these scenarios here, against the real
 * recordRun/refundReservedIfAny code paths with only the actual on-chain
 * call mocked out, proves the same thing a live toggle would — that refunds
 * fire correctly in every scenario — without that risk.
 */
const refundReservationViaAgent = vi.fn();
vi.mock("@/lib/monad/contracts", () => ({ refundReservationViaAgent }));

const { createSchedule, recordRun, getSchedule, cancelSchedule, deleteSchedule } = await import("@/lib/platform/schedules");

function makeReserved(overrides: Partial<Parameters<typeof createSchedule>[1]> = {}) {
  return createSchedule("merchant-testmode", {
    amount: 25,
    token: "USDC",
    tokenDecimals: 6,
    recipient: "0x1234567890abcdef1234567890abcdef12345678",
    cadence: "weekly", // stays live across retries, unlike "once"
    nextRun: Date.now() - 1000,
    fundingMode: "reserved",
    ...overrides,
  });
}

beforeEach(() => {
  refundReservationViaAgent.mockReset();
});

describe("TEST MODE — simulated failure scenarios", () => {
  it("scenario: cancelled automation before execution → refunds immediately", async () => {
    refundReservationViaAgent.mockResolvedValue({
      outcome: "refunded", txHash: "0xcancel", explorerUrl: "https://monadscan.com/tx/0xcancel", amountRaw: 25_000_000n,
    });
    const s = await makeReserved();
    // Never executed even once — cancelled cold.
    const after = await cancelSchedule("merchant-testmode", s.id);
    expect(after!.status).toBe("cancelled");
    expect(after!.reserveRefundStatus).toBe("refunded");
    expect(after!.refundHistory![0].reason).toContain("cancelled");
  });

  it("scenario: deleted automation with an active reservation → refunds on delete", async () => {
    refundReservationViaAgent.mockResolvedValue({
      outcome: "refunded", txHash: "0xdelete", explorerUrl: "https://monadscan.com/tx/0xdelete", amountRaw: 25_000_000n,
    });
    const s = await makeReserved();
    const ok = await deleteSchedule("merchant-testmode", s.id);
    expect(ok).toBe(true);
    expect(refundReservationViaAgent).toHaveBeenCalledWith(s.id, s.vaultAddress);
  });

  it("scenario: repeated execution failure (e.g. insufficient funds in the vault) exhausts retries and auto-refunds the remainder", async () => {
    refundReservationViaAgent.mockResolvedValue({
      outcome: "refunded", txHash: "0xexhausted", explorerUrl: "https://monadscan.com/tx/0xexhausted", amountRaw: 5_000_000n,
    });
    const s = await makeReserved();
    // Simulate 3 consecutive failed executions — release() reverting because
    // the reservation can't cover this occurrence's amount is exactly the
    // "Insufficient funds" scenario: the automation retries the SAME
    // occurrence (same backoff path as any other execution error) rather
    // than skipping ahead, since nothing was actually paid.
    for (let i = 0; i < 3; i++) {
      await recordRun(s.id, { at: Date.now(), decision: "error", detail: "insufficient reserved balance for this occurrence" });
    }
    const after = await getSchedule(s.id);
    expect(after!.status).toBe("failed");
    expect(after!.failureCount).toBe(3);
    expect(after!.reserveRefundStatus).toBe("refunded");
    expect(after!.refundHistory![0].reason).toContain("failed execution");
  });

  it("scenario: RPC timeout during the refund attempt itself → marked pending, not silently lost", async () => {
    // The chain call throwing entirely (network drop mid-call) rather than
    // returning a clean { outcome: "failed" } — refundReservationViaAgent
    // itself always catches internally in real code, but this proves
    // schedules.ts's own outer catch handles it identically either way.
    refundReservationViaAgent.mockRejectedValue(new Error("RPC request timed out"));
    const s = await makeReserved({ cadence: "once" });
    await recordRun(s.id, { at: Date.now(), decision: "executed" }); // completes -> terminal -> attempts refund
    const after = await getSchedule(s.id);
    expect(after!.status).toBe("completed");
    expect(after!.reserveRefundStatus).toBe("pending");
    expect(after!.reserveRefundTxHash ?? null).toBeNull();
  });

  it("scenario: smart contract revert on the refund tx → marked pending and safely retryable, never marked refunded", async () => {
    refundReservationViaAgent.mockResolvedValue({ outcome: "failed" }); // receipt.status !== "success"
    const s = await makeReserved({ cadence: "once" });
    await recordRun(s.id, { at: Date.now(), decision: "executed" });
    let after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBe("pending");

    // Verify it's genuinely retryable, not stuck: a later successful attempt
    // (e.g. via retryPendingRefunds, or the user cancelling again) resolves it.
    refundReservationViaAgent.mockResolvedValue({
      outcome: "refunded", txHash: "0xrevert-recovered", explorerUrl: "https://monadscan.com/tx/0xrevert-recovered", amountRaw: 25_000_000n,
    });
    const { retryPendingRefunds } = await import("@/lib/platform/schedules");
    await retryPendingRefunds();
    after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBe("refunded");
  });

  it("scenario: network interruption mid-execution (not just mid-refund) still lets the automation reach a refundable terminal state", async () => {
    refundReservationViaAgent.mockResolvedValue({
      outcome: "refunded", txHash: "0xnetdrop", explorerUrl: "https://monadscan.com/tx/0xnetdrop", amountRaw: 25_000_000n,
    });
    const s = await makeReserved();
    // A dropped connection during execute() surfaces to recordRun exactly
    // like any other execution error — there is no special "network" path
    // to fake separately, which is itself the point: every failure cause
    // funnels through the same retry/refund logic, so there's nothing that
    // can fall through a gap unique to this cause.
    await recordRun(s.id, { at: Date.now(), decision: "error", detail: "fetch failed: network interruption" });
    await recordRun(s.id, { at: Date.now(), decision: "error", detail: "fetch failed: network interruption" });
    await recordRun(s.id, { at: Date.now(), decision: "error", detail: "fetch failed: network interruption" });
    const after = await getSchedule(s.id);
    expect(after!.status).toBe("failed");
    expect(after!.reserveRefundStatus).toBe("refunded");
  });
});
