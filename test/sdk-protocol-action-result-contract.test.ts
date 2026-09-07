import { afterEach, describe, expect, it, vi } from "vitest";
import type { Operation, ProtocolActionIntent } from "@/lib/ask/types";

/**
 * Phase 3A §5 — the quote/preview boundary must stay visibly distinct from
 * the confirmed on-chain result. This was found genuinely broken during the
 * Phase 3A re-verification: /api/ask/action/confirm computes the action's
 * real parseResult() output (from receipt-verified logs) and then the
 * client discarded it — result carried only {txHash, explorerUrl}, so a
 * success card had nothing to render except the ORIGINAL PREVIEW's
 * predicted `intent.data.details`, with no way to tell the two apart. Fixed
 * by threading confirm.details into result.confirmedDetails (see
 * lib/ask/types.ts's TransactionResult and orchestrate.ts's
 * executeProtocolActionIntent). These tests prove the fix and pin the
 * distinction going forward.
 */

function protocolActionOperation(): Operation {
  const data: ProtocolActionIntent["data"] = {
    protocol: { id: "wmon", name: "Wrapped MON" },
    action: { id: "wrap", name: "Wrap MON", description: "d", version: "1.0.0" },
    chainId: 143, network: "Monad",
    inputs: { amount: "1" },
    summary: "Wrap 1 MON into 1 WMON", // the PREDICTION
    details: { rate: "1 MON = 1 WMON", youReceive: "1 WMON" }, // the PREDICTION
    quotedAt: Date.now(),
  };
  const intent: ProtocolActionIntent = {
    kind: "protocol_action", network: "monad", data,
    execution: { request: { protocolId: "wmon", actionId: "wrap", version: "1.0.0", inputs: { amount: "1" }, chainId: 143 } },
  };
  return { id: "op1", intent, status: "ready" };
}

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

function mockFetchSequence(buildJson: unknown, confirmJson: unknown) {
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes("/api/ask/action/build")) return new Response(JSON.stringify(buildJson), { status: 200 });
    if (String(url).includes("/api/ask/action/confirm")) return new Response(JSON.stringify(confirmJson), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("executeProtocolActionIntent — confirmed result is distinct from the preview's prediction", () => {
  it("result.confirmedDetails carries parseResult()'s REAL on-chain output, not the quote's prediction", async () => {
    mockFetchSequence(
      { ok: true, steps: [{ kind: "action", label: "Wrap 1 MON", tx: { to: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", data: "0xd0e30db0", value: "0xde0b6b3a7640000" } }] },
      // parseResult's REAL confirmed output -- deliberately a DIFFERENT number
      // than the preview's "1 WMON" prediction, so a test that accidentally
      // rendered the preview instead would visibly disagree with this.
      { ok: true, success: true, explorerUrl: "https://monadexplorer.com/tx/0xreal", details: { status: "success", wrapped: "0.999999999999999999" } },
    );
    const { executeProtocolActionIntent } = await import("@/lib/ask/intent/orchestrate");
    const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xreal"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
    const result = await executeProtocolActionIntent(protocolActionOperation(), wallet, "0x9999999999999999999999999999999999999999");

    expect(result.status).toBe("success");
    expect(result.result?.confirmedDetails).toEqual({ status: "success", wrapped: "0.999999999999999999" });
    // The PREVIEW's prediction must still be reachable (it's real history of
    // what was shown before signing) but must NEVER be mistaken for the
    // confirmed number -- they are different values here on purpose.
    if (result.intent.kind !== "protocol_action") throw new Error("expected protocol_action");
    expect(result.intent.data.details.youReceive).toBe("1 WMON"); // untouched preview data
    expect(result.result?.confirmedDetails?.wrapped).not.toBe("1"); // confirmed != predicted in this test
  });

  it("a parseResult with nothing to report leaves confirmedDetails absent, never backfilled from the quote", async () => {
    mockFetchSequence(
      { ok: true, steps: [{ kind: "action", label: "Wrap 1 MON", tx: { to: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", data: "0xd0e30db0", value: "0xde0b6b3a7640000" } }] },
      { ok: true, success: true, explorerUrl: "https://monadexplorer.com/tx/0xreal2", details: {} },
    );
    const { executeProtocolActionIntent } = await import("@/lib/ask/intent/orchestrate");
    const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xreal2"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
    const result = await executeProtocolActionIntent(protocolActionOperation(), wallet, "0x9999999999999999999999999999999999999999");
    expect(result.result?.confirmedDetails).toEqual({});
  });
});
