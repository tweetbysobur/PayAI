import { afterEach, describe, expect, it, vi } from "vitest";
import type { Operation, ProtocolActionIntent } from "@/lib/ask/types";

/**
 * Phase 5B — ERC-20 split execution states. Drives executeProtocolActionIntent
 * with a mocked two-step build (approve + splitPayment) and proves the multi-
 * step semantics: the approval hash is never shown as the settlement hash; a
 * split that reverts AFTER a successful approval is a clear error carrying BOTH
 * hashes distinctly; and an approval that itself reverts stops before the split
 * with no false success.
 */

function erc20Operation(): Operation {
  const data: ProtocolActionIntent["data"] = {
    protocol: { id: "payai-settlement", name: "PayAI Split Settlement" },
    action: { id: "split_payment", name: "Split Payment", description: "d", version: "1.0.0" },
    chainId: 143, network: "Monad",
    inputs: { token: "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60", recipient1: "0x1111111111111111111111111111111111111111", amount1: "100" },
    summary: "Split 100 USDC between 1 recipient",
    details: { total: "100 USDC" },
    quotedAt: Date.now(),
  };
  const intent: ProtocolActionIntent = {
    kind: "protocol_action", network: "monad", data,
    execution: { request: { protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0", inputs: data.inputs, chainId: 143 } },
  };
  return { id: "op1", intent, status: "ready" };
}

const APPROVE = "0xapprove000000000000000000000000000000000000000000000000000000000";
const SETTLE = "0xsettle0000000000000000000000000000000000000000000000000000000000";

const buildJson = {
  ok: true,
  steps: [
    { kind: "approve", label: "Approve", tx: { to: "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60", data: "0x095ea7b3", value: "0" } },
    { kind: "action", label: "Split", tx: { to: "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F", data: "0xabcd", value: "0" } },
  ],
};

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

function mockFetch(confirmJson: unknown) {
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes("/api/ask/action/build")) return new Response(JSON.stringify(buildJson), { status: 200 });
    if (String(url).includes("/api/ask/action/confirm")) return new Response(JSON.stringify(confirmJson), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

/** A wallet that returns the approval hash first, then the settlement hash, and
 *  reports each receipt's status from a map. */
function wallet(statuses: Record<string, string>) {
  let n = 0;
  return {
    sendTransaction: vi.fn(async () => (n++ === 0 ? APPROVE : SETTLE)),
    waitForReceipt: vi.fn(async (h: string) => ({ status: statuses[h] ?? "success" })),
  };
}

describe("ERC-20 split execution", () => {
  it("approval + split both succeed: result uses the SETTLEMENT hash, approval kept distinct", async () => {
    mockFetch({ ok: true, success: true, explorerUrl: "https://x/tx/settle", details: { status: "success", settlementId: "0" } });
    const { executeProtocolActionIntent } = await import("@/lib/ask/intent/orchestrate");
    const res = await executeProtocolActionIntent(erc20Operation(), wallet({}), "0x9999999999999999999999999999999999999999");
    expect(res.status).toBe("success");
    expect(res.result?.txHash).toBe(SETTLE);
    expect(res.result?.txHash).not.toBe(APPROVE); // approval hash never shown as the settlement
    expect(res.result?.confirmedDetails).toEqual({ status: "success", settlementId: "0" });
  });

  it("approval succeeds, split REVERTS: error carries the settlement hash AND the distinct approval hash", async () => {
    mockFetch({ ok: false, reverted: true, explorerUrl: "https://x/tx/settle", message: "The split reverted on-chain. No funds moved." });
    const { executeProtocolActionIntent } = await import("@/lib/ask/intent/orchestrate");
    const res = await executeProtocolActionIntent(erc20Operation(), wallet({}), "0x9999999999999999999999999999999999999999");
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("REVERTED");
    expect(res.error?.txHash).toBe(SETTLE);
    expect(res.error?.approvalTx?.txHash).toBe(APPROVE); // distinct, preserved
    expect(res.error?.approvalTx?.txHash).not.toBe(res.error?.txHash);
  });

  it("approval itself REVERTS: stops before the split, no false success, approval hash reported", async () => {
    mockFetch({ ok: true, success: true }); // confirm would say success, but we never reach it
    const { executeProtocolActionIntent } = await import("@/lib/ask/intent/orchestrate");
    const w = wallet({ [APPROVE]: "reverted" });
    const res = await executeProtocolActionIntent(erc20Operation(), w, "0x9999999999999999999999999999999999999999");
    expect(res.status).toBe("error");
    expect(res.error?.code).toBe("APPROVAL_FAILED");
    expect(res.error?.txHash).toBe(APPROVE);
    expect(w.sendTransaction).toHaveBeenCalledTimes(1); // split was never signed
  });
});
