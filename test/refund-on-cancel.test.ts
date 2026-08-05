import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every route out of "this automation will run again" must return the deposit.
 *
 * Reserved Funds holds a real deposit in the vault. The refund lived alongside
 * the obvious exits — `cancelSchedule` and `deleteSchedule` — and not alongside
 * every route that can actually reach a terminal state. Two did not refund:
 *
 *   - `setScheduleStatus(..., "cancelled")`, which is the path the dashboard's
 *     Cancel button takes.
 *   - `skipNextRun`, when skipping the final occurrence completes the schedule.
 *
 * The money was not lost — it sits in the vault, refundable — but it was
 * stranded with no route back that a user could find. The retry sweeper only
 * looks at rows marked "pending", which neither path ever set, and the
 * dashboard only offers refund recovery on that same marker. So no automatic
 * attempt was ever made and nothing on screen said anything was wrong.
 *
 * `refundReservationViaAgent` is mocked: these are about schedules.ts calling
 * it at all, not about the chain call itself.
 */
const refundReservationViaAgent = vi.fn();
vi.mock("@/lib/monad/contracts", () => ({ refundReservationViaAgent }));

const {
  createSchedule, getSchedule, setScheduleStatus, cancelSchedule, deleteSchedule, skipNextRun,
} = await import("@/lib/platform/schedules");

const MERCHANT = "merchant-cancel-refund";
const OWNER = "0xaaaa000000000000000000000000000000000001";

function reserved(overrides: Partial<Parameters<typeof createSchedule>[1]> = {}) {
  return createSchedule(MERCHANT, {
    amount: 25,
    token: "USDC",
    recipient: "0x1234567890abcdef1234567890abcdef12345678",
    cadence: "once",
    nextRun: Date.now() + 60_000,
    fundingMode: "reserved",
    sender: OWNER,
    ...overrides,
  });
}

beforeEach(() => {
  refundReservationViaAgent.mockReset();
  refundReservationViaAgent.mockResolvedValue({
    outcome: "refunded",
    txHash: "0x" + "ab".repeat(32),
    explorerUrl: "https://explorer/tx",
    amountRaw: 25_000_000n,
  });
});

describe("cancelling returns the deposit", () => {
  it("refunds when cancelled through the status route the dashboard uses", async () => {
    const s = await reserved();
    await setScheduleStatus(MERCHANT, s.id, "cancelled", { sender: OWNER });

    expect(refundReservationViaAgent, "cancelling must hand the deposit back").toHaveBeenCalledTimes(1);
    const after = await getSchedule(s.id);
    expect(after!.status).toBe("cancelled");
    expect(after!.reserveRefundStatus).toBe("refunded");
  });

  it("refunds when cancelled through cancelSchedule", async () => {
    const s = await reserved();
    await cancelSchedule(MERCHANT, s.id, { sender: OWNER });
    expect(refundReservationViaAgent).toHaveBeenCalledTimes(1);
    expect((await getSchedule(s.id))!.reserveRefundStatus).toBe("refunded");
  });

  it("refunds when deleted outright, without cancelling first", async () => {
    const s = await reserved();
    await deleteSchedule(MERCHANT, s.id, { sender: OWNER });
    expect(refundReservationViaAgent).toHaveBeenCalledTimes(1);
  });

  it("refunds when skipping the final occurrence completes the schedule", async () => {
    const s = await reserved({ cadence: "once", nextRun: Date.now() + 60_000 });
    await skipNextRun(MERCHANT, s.id, { sender: OWNER });

    const after = await getSchedule(s.id);
    expect(after!.status, "skipping the only run completes it").toBe("completed");
    expect(refundReservationViaAgent, "a completed automation has nothing left to hold").toHaveBeenCalledTimes(1);
  });

  it("does not refund when a skip merely advances to the next occurrence", async () => {
    // Still live, still needs its deposit. Refunding here would empty a
    // running automation.
    const s = await reserved({ cadence: "weekly", nextRun: Date.now() + 60_000 });
    await skipNextRun(MERCHANT, s.id, { sender: OWNER });

    expect((await getSchedule(s.id))!.status).toBe("active");
    expect(refundReservationViaAgent).not.toHaveBeenCalled();
  });

  it("refunds once, however many times it is cancelled", async () => {
    // The dashboard, the AI route and a double-tap can all land on the same
    // row. Two refunds would be a genuine loss to whoever funds the vault.
    const s = await reserved();
    await setScheduleStatus(MERCHANT, s.id, "cancelled", { sender: OWNER });
    await setScheduleStatus(MERCHANT, s.id, "cancelled", { sender: OWNER });
    await cancelSchedule(MERCHANT, s.id, { sender: OWNER });
    await deleteSchedule(MERCHANT, s.id, { sender: OWNER });

    expect(refundReservationViaAgent).toHaveBeenCalledTimes(1);
  });

  it("leaves a wallet-funded automation alone — there is no deposit to return", async () => {
    const s = await reserved({ fundingMode: "wallet" });
    await setScheduleStatus(MERCHANT, s.id, "cancelled", { sender: OWNER });
    expect(refundReservationViaAgent).not.toHaveBeenCalled();
  });

  it("marks a refund that did not land as pending, so the sweeper retries it", async () => {
    // The point of the marker: it is what retryPendingRefunds looks for. A
    // terminal row that never gets marked is one the sweeper never sees.
    refundReservationViaAgent.mockResolvedValue({ outcome: "failed" });
    const s = await reserved();
    await setScheduleStatus(MERCHANT, s.id, "cancelled", { sender: OWNER });

    expect((await getSchedule(s.id))!.reserveRefundStatus).toBe("pending");
  });

  it("does not let a stranger cancel someone else's automation into a refund", async () => {
    const s = await reserved();
    const result = await setScheduleStatus(MERCHANT, s.id, "cancelled", {
      sender: "0xbbbb000000000000000000000000000000000002",
    });

    expect(result).toBeNull();
    expect(refundReservationViaAgent).not.toHaveBeenCalled();
    expect((await getSchedule(s.id))!.status).not.toBe("cancelled");
  });
});
