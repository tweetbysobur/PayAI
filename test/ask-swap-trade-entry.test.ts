import { describe, expect, it } from "vitest";
import { routeRequest } from "@/lib/ask/intent/classify";
import { detectSwapIntent } from "@/lib/agent/brain";

/**
 * The Trade / Swap on-ramps (Ask's "Trade a token" chip, the dashboard's
 * "Trade" quick action which types "Swap ", the Swap page) send plain words.
 * When the model is slow or unreachable the deterministic fallback answers, and
 * it used to dead-end at "unclear" for the bare verbs and miss "my" in
 * "convert my MON to USDC".
 */
const fallback = async (t: string) => (await routeRequest(t, null)).fallback ?? (await routeRequest(t, null)).understanding;

describe("bare swap/trade entry points ask for what's missing instead of 'unclear'", () => {
  it.each(["Swap", "swap ", "Trade", "trade", "swap tokens", "Swap a token", "trade some crypto", "Swap!"])("%j", async (t) => {
    const u = await fallback(t);
    expect(u?.outcome).toBe("incomplete");
    expect(u?.kind === "trade" || u?.kind === "swap").toBe(true);
    expect((u as { question?: string }).question).toMatch(/\?$/);
  });
  it("the chip label still works", async () => {
    const u = await fallback("Trade a token");
    expect(u?.kind).toBe("trade");
    expect(u?.outcome).toBe("incomplete");
  });
});

describe("swap wording with a possessive", () => {
  it.each([
    ["convert my mon to usdc", "MON", "USDC", null],
    ["swap my MON for USDC", "MON", "USDC", null],
    ["exchange some mon into usdc", "MON", "USDC", null],
    ["swap 5 of my MON to USDC", "MON", "USDC", 5],
  ])("%s", (t, from, to, amount) => {
    expect(detectSwapIntent(t)).toEqual({ fromToken: from, toToken: to, amount });
  });
  it("existing forms are unchanged", () => {
    expect(detectSwapIntent("swap 5 MON to USDC")).toEqual({ fromToken: "MON", toToken: "USDC", amount: 5 });
    expect(detectSwapIntent("swap mon to usdc")).toEqual({ fromToken: "MON", toToken: "USDC", amount: null });
    expect(detectSwapIntent("swap 1,5 usdc to mon")).toEqual({ fromToken: "USDC", toToken: "MON", amount: 1.5 });
    expect(detectSwapIntent("send 5 MON to bob")).toBeNull();
  });
  it("a missing amount is asked, not guessed", async () => {
    const u = await fallback("convert my mon to usdc");
    expect(u).toMatchObject({ kind: "swap", outcome: "incomplete" });
  });
});
