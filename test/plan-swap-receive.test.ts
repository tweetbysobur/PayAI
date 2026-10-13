import { describe, expect, it } from "vitest";
import { receivedAmount, swapReceive } from "@/lib/plans-client/swapReceive";

const step = {
  nodeId: "n1", order: 1, action: "swap" as const,
  pay: { kind: "exact" as const, units: "35000000000000000000", decimal: "35", symbol: "MON" },
  receiveToken: { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" },
  slippageBps: 50,
};
const node = (state: string, outputs: Record<string, unknown> | null) => ({
  nodeId: "n1", ref: {} as never, dependsOn: [], state, quoteAttempts: 1, quoteId: "q", txHash: "0xabc",
  result: { status: "recorded", outputs }, signing: null,
}) as never;

describe("what a plan swap returns, on the card", () => {
  it("shows the verified on-chain amount once confirmed", () => {
    const n = node("confirmed", { amountOut: { verified: true, type: "units", value: "856030", token: "0x7547" } });
    expect(receivedAmount(step, n)).toBe("0.85603 USDC");
    expect(swapReceive(step, n, undefined, null)).toMatchObject({ label: "You received", value: "0.85603 USDC" });
  });

  it("never shows an unverified output as received", () => {
    const n = node("confirmed", { amountOut: { verified: false, type: "units", value: "999999999", token: "0x7547" } });
    expect(receivedAmount(step, n)).toBeNull();
  });

  it("uses the quote the swap ran on before it confirms, with the minimum and the total", () => {
    const quoted = { "you receive (est.)": "0.856 USDC", "minimum received": "0.8517 USDC", "total from your balance": "35.0877 MON" };
    expect(swapReceive(step, node("submitted", null), quoted, null)).toEqual({
      label: "You receive", value: "≈ 0.856 USDC", note: "quoted", minimum: "0.8517 USDC", total: "35.0877 MON",
    });
  });

  it("falls back to the live estimate, labelled as one", () => {
    const r = swapReceive(step, undefined, undefined, { receive: "0.85 USDC", minimum: "0.84 USDC", total: "35.08 MON" });
    expect(r).toMatchObject({ value: "≈ 0.85 USDC", note: "estimate" });
  });

  it("says nothing it doesn't know", () => {
    expect(swapReceive(step, undefined, undefined, null)).toBeNull();
  });
});
