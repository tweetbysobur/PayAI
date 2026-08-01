import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked BEFORE importing schedules.ts, so every call to
// refundReservationViaAgent inside refundReservedIfAny goes through this
// mock instead of touching a real RPC/agent wallet — these tests are about
// verifying schedules.ts correctly turns each of the three possible outcomes
// into the right persisted reserveRefundStatus/refundHistory, not about
// exercising the actual chain call.
const refundReservationViaAgent = vi.fn();
vi.mock("@/lib/monad/contracts", () => ({ refundReservationViaAgent }));

const { createSchedule, recordRun, getSchedule, cancelSchedule, retryPendingRefunds } = await import("@/lib/platform/schedules");

function makeReserved(overrides: Partial<Parameters<typeof createSchedule>[1]> = {}) {
  return createSchedule("merchant-refund", {
    amount: 10,
    token: "USDC",
    recipient: "0x1234567890abcdef1234567890abcdef12345678",
    cadence: "once",
    nextRun: Date.now() - 1000,
    fundingMode: "reserved",
    ...overrides,
  });
}

beforeEach(() => {
  refundReservationViaAgent.mockReset();
});

// Mini Sprint Part 1: the three-way refund outcome must map to the right
// persisted state, because collapsing "nothing owed" and "refund failed"
// into the same signal is exactly the bug that once left real funds looking
// identical to a fully-settled automation.
describe("refund status derivation on terminal states", () => {
  it("outcome 'none' (nothing reserved) sets reserveRefundStatus to 'none', not 'pending'", async () => {
    refundReservationViaAgent.mockResolvedValue({ outcome: "none" });
    const s = await makeReserved();
    await recordRun(s.id, { at: Date.now(), decision: "executed" }); // completes a "once" cadence -> terminal
    const after = await getSchedule(s.id);
    expect(after!.status).toBe("completed");
    expect(after!.reserveRefundStatus).toBe("none");
    expect(after!.refundHistory ?? []).toHaveLength(0);
  });

  it("outcome 'failed' (RPC hiccup, still reserved) sets reserveRefundStatus to 'pending'", async () => {
    refundReservationViaAgent.mockResolvedValue({ outcome: "failed" });
    const s = await makeReserved();
    await recordRun(s.id, { at: Date.now(), decision: "executed" });
    const after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBe("pending");
    expect(after!.reserveRefundTxHash ?? null).toBeNull();
  });

  it("outcome 'refunded' sets reserveRefundStatus to 'refunded' and appends a refundHistory record", async () => {
    refundReservationViaAgent.mockResolvedValue({
      outcome: "refunded", txHash: "0xabc", explorerUrl: "https://monadscan.com/tx/0xabc", amountRaw: 10_000_000n,
    });
    const s = await makeReserved({ tokenDecimals: 6 });
    await recordRun(s.id, { at: Date.now(), decision: "executed" });
    const after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBe("refunded");
    expect(after!.reserveRefundTxHash).toBe("0xabc");
    expect(after!.refundHistory).toHaveLength(1);
    expect(after!.refundHistory![0]).toMatchObject({ amount: 10, txHash: "0xabc", automationId: s.id });
  });

  it("cancelling a reserved automation with nothing left to refund does not fabricate a 'pending' state", async () => {
    refundReservationViaAgent.mockResolvedValue({ outcome: "none" });
    const s = await makeReserved({ cadence: "weekly" }); // stays live, so cancel is the only path to terminal
    const after = await cancelSchedule("merchant-refund", s.id);
    expect(after!.status).toBe("cancelled");
    expect(after!.reserveRefundStatus).toBe("none");
  });

  it("a row already marked 'refunded' is never re-checked on-chain (prevents a duplicate-refund status downgrade)", async () => {
    refundReservationViaAgent.mockResolvedValue({
      outcome: "refunded", txHash: "0xfirst", explorerUrl: "https://monadscan.com/tx/0xfirst", amountRaw: 10_000_000n,
    });
    const s = await makeReserved({ tokenDecimals: 6 });
    // First terminal transition — refunds successfully.
    await recordRun(s.id, { at: Date.now(), decision: "executed" });
    let after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBe("refunded");

    // A second, redundant trigger on the same already-refunded automation
    // (e.g. a race between cancel/delete and the terminal recordRun path)
    // must NOT re-check on-chain and must NOT downgrade the status — this is
    // exactly the bug a naive "outcome none -> reserveRefundStatus none"
    // mapping would cause, since a second on-chain check would correctly see
    // reservedBalance === 0 and misread that as "nothing was ever owed."
    refundReservationViaAgent.mockResolvedValue({ outcome: "none" });
    await cancelSchedule("merchant-refund", s.id);
    after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBe("refunded");
    expect(after!.refundHistory).toHaveLength(1);
  });

  it("concurrent refund attempts on the same automation don't race — only one applies its outcome", async () => {
    let resolveFirst!: (v: unknown) => void;
    const firstCallPromise = new Promise((resolve) => { resolveFirst = resolve; });
    refundReservationViaAgent
      .mockImplementationOnce(() => firstCallPromise)
      .mockResolvedValue({ outcome: "failed" }); // if the mutex failed, this would run concurrently and could win

    const s = await makeReserved({ tokenDecimals: 6, cadence: "weekly" });
    const p1 = cancelSchedule("merchant-refund", s.id);
    // Give the first call a moment to claim the lock before the second fires.
    await new Promise((r) => setTimeout(r, 5));
    const p2 = cancelSchedule("merchant-refund", s.id); // second call must no-op — the automation is already cancelled/terminal, but exercises the same lock path if reached concurrently

    resolveFirst({ outcome: "refunded", txHash: "0xrace", explorerUrl: "https://monadscan.com/tx/0xrace", amountRaw: 10_000_000n });
    await Promise.all([p1, p2]);

    const after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBe("refunded");
    expect(after!.refundHistory).toHaveLength(1);
  });

  it("retryPendingRefunds resolves a 'pending' automation once the chain call succeeds", async () => {
    refundReservationViaAgent.mockResolvedValue({ outcome: "failed" });
    const s = await makeReserved({ tokenDecimals: 6 });
    await recordRun(s.id, { at: Date.now(), decision: "executed" });
    expect((await getSchedule(s.id))!.reserveRefundStatus).toBe("pending");

    refundReservationViaAgent.mockResolvedValue({
      outcome: "refunded", txHash: "0xretry", explorerUrl: "https://monadscan.com/tx/0xretry", amountRaw: 10_000_000n,
    });
    const retried = await retryPendingRefunds();
    expect(retried).toBeGreaterThanOrEqual(1);
    const after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBe("refunded");
    expect(after!.refundHistory).toHaveLength(1);
  });

  it("a Wallet Automation (non-reserved) never touches refund status at all", async () => {
    const s = await createSchedule("merchant-refund", {
      amount: 10, token: "USDC", recipient: "0x1234567890abcdef1234567890abcdef12345678",
      cadence: "once", nextRun: Date.now() - 1000, fundingMode: "wallet",
    });
    await recordRun(s.id, { at: Date.now(), decision: "executed" });
    expect(refundReservationViaAgent).not.toHaveBeenCalled();
    const after = await getSchedule(s.id);
    expect(after!.reserveRefundStatus).toBeUndefined();
  });
});
