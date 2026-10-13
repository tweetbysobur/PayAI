import { describe, it, expect } from "vitest";
import { analyzePlanRequest, reorderRecipientFirst, toPlanText } from "@/lib/ask/planFastPath";

describe("recipient-first transfers become a plan", () => {
  it("rewrites 'pay alice.nad 1 MON and bob.nad 2 MON' without changing any value", () => {
    expect(reorderRecipientFirst("pay alice.nad 1 MON and bob.nad 2 MON")).toBe("send 1 MON to alice.nad, 2 MON to bob.nad");
    expect(analyzePlanRequest(toPlanText("pay alice.nad 1 MON and bob.nad 2 MON"))).toEqual({ kind: "multi", actions: 2 });
  });
  it("handles mixed tokens, addresses and a verb on every clause", () => {
    const a = "0x0264538C189FdFccFe233Fb1413e444f81638F7f";
    expect(reorderRecipientFirst(`send alice.nad 1 MON, send ${a} 2.5 USDC and bob.nad 3 MON`))
      .toBe(`send 1 MON to alice.nad, 2.5 USDC to ${a}, 3 MON to bob.nad`);
  });
  it("leaves a single transfer to the normal path", () => {
    expect(reorderRecipientFirst("pay alice.nad 1 MON")).toBeNull();
  });
  it("never treats a bare word as a recipient", () => {
    expect(reorderRecipientFirst("pay alice 1 MON and bob 2 MON")).toBeNull();
    expect(reorderRecipientFirst("send it 1 MON and bob.nad 2 MON")).toBeNull();
  });
  it("refuses anything left over or out of shape", () => {
    expect(reorderRecipientFirst("pay alice.nad 1 MON and swap 2 MON to USDC")).toBeNull();
    expect(reorderRecipientFirst("pay alice.nad 1 MON and bob.nad")).toBeNull();
    expect(reorderRecipientFirst("pay alice.nad 1 MON now and bob.nad 2 MON")).toBeNull();
  });
  it("does not disturb requests already in plan order", () => {
    expect(toPlanText("send 1 MON to alice.nad and 2 MON to bob.nad")).toBe("send 1 MON to alice.nad and 2 MON to bob.nad");
    expect(toPlanText("send 5 USDC each to alice.nad and bob.nad")).toBe("send 5 USDC to alice.nad, 5 USDC to bob.nad");
  });
});
