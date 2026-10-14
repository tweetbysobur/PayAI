import { describe, expect, it } from "vitest";
import { resolveVisualIntent } from "@/lib/ask/visual/resolve";
import { parseIntent } from "@/lib/plan-adapter/grammar";
import { toPlanText } from "@/lib/ask/planFastPath";

/** An image reading "Swap 1 MON to USDC and send the usdc to gentle.nad". */
const image = (send: Record<string, unknown>) => ({
  kind: "payment_instruction" as const,
  actions: [
    { type: "swap" as const, amount: "1", token: "MON", toToken: "USDC", recipient: null, amountFromPrevious: false },
    { type: "send" as const, amount: null, token: "USDC", toToken: null, recipient: "gentle.nad", amountFromPrevious: false, ...send },
  ],
  addresses: [],
  invoice: null,
  suspicious: false,
});

describe("visual intent: a swap and a send of its output", () => {
  it("reads the instruction as the swap, then sending exactly what it returned", () => {
    const r = resolveVisualIntent({ qr: null, caption: "", image: image({ amountFromPrevious: true }) });
    expect(r).toMatchObject({ kind: "intent", text: "Swap 1 MON to USDC and send it to gentle.nad" });
    const plan = parseIntent(toPlanText((r as { text: string }).text), { monDecimals: 18, stable: { symbol: "USDC", decimals: 6 } });
    expect(plan.ok).toBe(true);
  });

  it("still does when the reader leaves the swap-output flag off", () => {
    const r = resolveVisualIntent({ qr: null, caption: "", image: image({}) });
    expect(r).toMatchObject({ kind: "intent", text: "Swap 1 MON to USDC and send it to gentle.nad" });
  });

  it("never treats a send of a different token as the swap's output", () => {
    const r = resolveVisualIntent({ qr: null, caption: "", image: image({ token: "MON" }) });
    expect(r.kind).not.toBe("intent");
  });

  it("never treats a send with its own amount as the swap's output", () => {
    const r = resolveVisualIntent({ qr: null, caption: "", image: image({ amount: "0.5" }) });
    expect(r).toMatchObject({ kind: "intent", text: "Swap 1 MON to USDC, then send 0.5 USDC to gentle.nad" });
  });
});
