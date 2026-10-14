import { describe, expect, it } from "vitest";
import { understand } from "@/lib/ask/intent/classify";
import { toPlanText, analyzePlanRequest } from "@/lib/ask/planFastPath";
import { parseIntent } from "@/lib/plan-adapter/grammar";

const tokens = { monDecimals: 18, stable: { symbol: "USDC", decimals: 6 } };
const slots = (u: Awaited<ReturnType<typeof understand>>) => (u as unknown as { slots: Record<string, unknown> }).slots;

describe("a buy spends the token after 'with' and receives the one after 'buy'", () => {
  it("never reverses the trade", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const s = slots(await understand("buy 10 USDC with MON", [], null));
    expect(s.fromAsset).toBe("MON");
    expect(s.toAsset).toBe("USDC");
    // 10 is what they want to receive — reported honestly, not spent.
    expect(s.amountType).toBe("exact_output");
  });

  it("an amount on the spent token is spent", async () => {
    const s = slots(await understand("buy MON with 10 USDC", [], null));
    expect(s.fromAsset).toBe("USDC");
    expect(s.toAsset).toBe("MON");
    expect(s.amount).toBe("10");
    expect(s.amountType).toBe("exact_input");
  });

  it("sell and swap phrasings are unchanged", async () => {
    const sell = slots(await understand("sell 5 MON for USDC", [], null));
    expect([sell.fromAsset, sell.toAsset, sell.amountType]).toEqual(["MON", "USDC", "exact_input"]);
  });
});

describe("a negative amount is refused, never read as positive", () => {
  for (const t of ["send -1 MON to bob.nad", "pay bob.nad -5 USDC", "swap -2 MON to USDC", "send −1 MON to bob.nad"]) {
    it(t, async () => {
      const u = await understand(t, [], null);
      expect(u.kind).toBe("unsupported");
      expect((u as { reply: string }).reply).toMatch(/positive/);
    });
  }
  it("a date or range with a dash is not a negative amount", async () => {
    const u = await understand("send 1 MON to bob.nad on 2026-10-20", [], null);
    expect(u.kind).not.toBe("unsupported");
  });
});

describe("a payment to a named recipient is not read as a trade", () => {
  it('"send $10 to bob.nad" keeps the recipient and asks for the token', async () => {
    const u = await understand("send $10 to bob.nad", [], null);
    expect(u.kind).toBe("send_payment");
    expect(slots(u).recipient).toBe("bob.nad");
  });
  it('"send all my MON to bob.nad" asks how much instead of quoting a trade', async () => {
    const u = await understand("send all my MON to bob.nad", [], null);
    expect(u.kind).toBe("send_payment");
    expect(u.outcome).toBe("incomplete");
  });
  it('"buy $10 of MON" is still a trade', async () => {
    expect((await understand("buy $10 of MON", [], null)).kind).toBe("trade");
  });
});

describe("tip is a send", () => {
  it("in the plan path", () => {
    const t = toPlanText("tip 1 MON to bob.nad");
    expect(analyzePlanRequest(t)?.kind).toBe("transfer");
    const r = parseIntent(t, tokens);
    expect(r.ok).toBe(true);
  });
  it("in the conversational path", async () => {
    const u = await understand("tip bob.nad 1 MON", [], null);
    expect(u.kind).toBe("send_payment");
    expect(slots(u).recipient).toBe("bob.nad");
  });
});

describe("plan refusals say what to write instead", () => {
  it("a swap into MON followed by 'send it' explains how to phrase it", () => {
    const r = parseIntent(toPlanText("swap 1 USDC to MON then send it to bob.nad"), tokens);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NATIVE_OUTPUT_NOT_BINDABLE");
    expect(r.message).toMatch(/send 1 MON to bob\.nad/);
  });
  it("an unsupported token names MON and USDC, not internal wording", () => {
    const r = parseIntent("send 1 USDT to bob.nad", tokens);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/MON and USDC/);
    expect(r.message).not.toMatch(/configured/);
  });
});
