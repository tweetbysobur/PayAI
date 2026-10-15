import { describe, expect, it } from "vitest";
import { routeRequest, understand } from "@/lib/ask/intent/classify";
import type { Understanding } from "@/lib/ask/intent/types";

/**
 * PayAI's trading rules for a token identified by its contract address:
 *   - it is BOUGHT with MON or USDC — whichever is named, otherwise asked;
 *   - it is SOLD into MON unless USDC is named;
 *   - amounts read as a percentage, "all", a $ value, or an exact amount —
 *     never a hex digit of the address, never a percentage read as a count.
 * All of it is deterministic: no model call, and nothing moves until the user
 * confirms the trade preview with their wallet.
 */
const T = "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";
const CONTEXT = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: T } } as unknown as Understanding;
const slots = (u: Understanding) => (u as unknown as { slots: Record<string, unknown> }).slots;

async function trade(text: string, pending: Understanding | null = null) {
  delete process.env.ANTHROPIC_API_KEY;
  return understand(text, [], pending);
}

describe("buying a contract-address token", () => {
  const cases: [string, Record<string, unknown>][] = [
    [`buy ${T} with 10 MON`, { fromAsset: "MON", toAsset: T, amount: "10", amountType: "exact_input" }],
    [`buy 10 MON of ${T}`, { fromAsset: "MON", toAsset: T, amount: "10", amountType: "exact_input" }],
    [`Buy ${T} with 5 USDC`, { fromAsset: "USDC", toAsset: T, amount: "5", amountType: "exact_input" }],
    [`buy $20 of ${T}`, { fromAsset: "USDC", toAsset: T, amount: "20", amountType: "usd" }],
    [`buy ${T} with half my MON`, { fromAsset: "MON", toAsset: T, amount: "50", amountType: "percentage" }],
  ];
  for (const [text, want] of cases) {
    it(text.replace(T, "<token>"), async () => {
      const u = await trade(text);
      expect(u.kind).toBe("trade");
      expect(u.outcome).toBe("complete");
      expect(slots(u)).toMatchObject({ tradeAction: "buy", ...want });
    });
  }

  it("asks MON or USDC when the pay token isn't named", async () => {
    const u = await trade(`buy ${T}`);
    expect(u.outcome).toBe("incomplete");
    expect((u as { question?: string }).question).toMatch(/MON or USDC/);
  });

  it("refuses to pay with anything but MON or USDC, and drops that amount", async () => {
    const u = await trade(`buy ${T} with 1 WETH`);
    expect(u.outcome).toBe("incomplete");
    expect(slots(u).fromAsset).toBeNull();
    expect(slots(u).amount).toBeNull();
    expect((u as { question?: string }).question).toMatch(/MON or USDC/);
  });

  it("an amount of the token itself is what they'd receive — reported honestly, never spent", async () => {
    const u = await trade(`buy 1000 of ${T}`);
    expect(slots(u).amountType).toBe("exact_output");
  });
});

describe("selling a contract-address token", () => {
  const cases: [string, Record<string, unknown>][] = [
    [`sell 50% of ${T}`, { amount: "50", amountType: "percentage", toAsset: "MON" }],
    [`Sell 25% of ${T}`, { amount: "25", amountType: "percentage", toAsset: "MON" }],
    [`sell half of ${T}`, { amount: "50", amountType: "percentage", toAsset: "MON" }],
    [`sell all ${T}`, { amountType: "balance_all", toAsset: "MON" }],
    [`Sell all of ${T}`, { amountType: "balance_all", toAsset: "MON" }],
    [`sell 1000 ${T}`, { amount: "1000", amountType: "exact_input", toAsset: "MON" }],
  ];
  for (const [text, want] of cases) {
    it(`${text.replace(T, "<token>")} → into MON`, async () => {
      const u = await trade(text);
      expect(u.outcome).toBe("complete");
      expect(slots(u)).toMatchObject({ tradeAction: "sell", fromAsset: T, ...want });
    });
  }

  it("sells into USDC only when USDC is named", async () => {
    const u = await trade(`sell 50% of ${T} for USDC`);
    expect(slots(u).toAsset).toBe("USDC");
  });

  it("asks how much, naming the asset it's sold into", async () => {
    const u = await trade(`sell ${T}`);
    expect(u.outcome).toBe("incomplete");
    expect((u as { question?: string }).question).toMatch(/25%, 50% or all.*MON/);
  });
});

describe("trades of the token just looked up", () => {
  it('"sell 50%" sells half the balance — never 50 tokens', async () => {
    expect(slots(await trade("sell 50%", CONTEXT))).toMatchObject({ fromAsset: T, toAsset: "MON", amount: "50", amountType: "percentage" });
  });
  it('"sell all" sells the whole balance into MON', async () => {
    const u = await trade("sell all", CONTEXT);
    expect(u.outcome).toBe("complete");
    expect(slots(u)).toMatchObject({ fromAsset: T, toAsset: "MON", amountType: "balance_all" });
  });
  it('"buy with 10 MON" and "buy 10 MON of this" buy the token', async () => {
    for (const t of ["buy with 10 MON", "buy 10 MON of this", "buy this with 10 MON"]) {
      expect(slots(await trade(t, CONTEXT)), t).toMatchObject({ fromAsset: "MON", toAsset: T, amount: "10" });
    }
  });
  it('"buy 10 MON with USDC" still buys MON, not the looked-up token', async () => {
    expect(slots(await trade("buy 10 MON with USDC", CONTEXT))).toMatchObject({ fromAsset: "USDC", toAsset: "MON" });
  });
  it('"sell 5 MON" still sells MON', async () => {
    expect(slots(await trade("sell 5 MON", CONTEXT))).toMatchObject({ fromAsset: "MON" });
  });
});

describe("answering the card's follow-up question", () => {
  it('"Buy this token" then "10 MON" completes the buy', async () => {
    const first = await trade("Buy this token", CONTEXT);
    expect(first.outcome).toBe("incomplete");
    const r = await routeRequest("10 MON", first);
    expect(r.understanding?.outcome).toBe("complete");
    expect(slots(r.understanding!)).toMatchObject({ fromAsset: "MON", toAsset: T, amount: "10" });
  });
  for (const [answer, want] of [["50%", { amount: "50", amountType: "percentage" }], ["max", { amountType: "balance_all" }], ["a quarter", { amount: "25", amountType: "percentage" }]] as const) {
    it(`"Sell this token" then "${answer}"`, async () => {
      const first = await trade("Sell this token", CONTEXT);
      const r = await routeRequest(answer, first);
      expect(r.understanding?.outcome).toBe("complete");
      expect(slots(r.understanding!)).toMatchObject({ fromAsset: T, toAsset: "MON", ...want });
    });
  }
});

describe("a pasted address alone, or a question about it, is still a lookup", () => {
  for (const t of [T, `what is ${T}`]) {
    it(t.replace(T, "<token>"), async () => {
      expect((await trade(t)).kind).toBe("token_lookup");
    });
  }
});

describe("curated sells and percentages", () => {
  it('"sell all my MON" is a complete sell of the whole balance', async () => {
    const u = await trade("sell all my MON");
    expect(u.outcome).toBe("complete");
    expect(slots(u)).toMatchObject({ fromAsset: "MON", toAsset: "USDC", amountType: "balance_all" });
  });
  it('"sell 25% of my USDC" is a percentage, into MON', async () => {
    expect(slots(await trade("sell 25% of my USDC"))).toMatchObject({ fromAsset: "USDC", toAsset: "MON", amount: "25", amountType: "percentage" });
  });
});
