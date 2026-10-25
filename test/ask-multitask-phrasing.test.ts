import { describe, expect, it } from "vitest";
import { analyzePlanRequest, normalizeClauses, toPlanText } from "@/lib/ask/planFastPath";

const A = "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a";
const B = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";

describe("several sends and swaps in one prompt, 0x addresses or .nad names", () => {
  it.each([
    [`pay ${A} 2 USDC and swap 1 USDC to MON`, `send 2 USDC to ${A} and swap 1 USDC to MON`, 2],
    [`buy USDC with 5 MON and send 2 USDC to ${B}`, `swap 5 MON to USDC and send 2 USDC to ${B}`, 2],
    ["sell 5 MON for USDC and send 1 USDC to gentle.nad", "swap 5 MON to USDC and send 1 USDC to gentle.nad", 2],
    [`send ${A} 1 MON, swap 2 MON to USDC`, `send 1 MON to ${A}, swap 2 MON to USDC`, 2],
    [`pay gentle.nad 1 MON, send 2 USDC to ${B}, buy MON with 3 USDC, sell 1 MON for USDC`, `send 1 MON to gentle.nad, send 2 USDC to ${B}, swap 3 USDC to MON, swap 1 MON to USDC`, 4],
    [`swap 2 USDC to MON\nsend 1 MON to ${A}\nsend 1 USDC to gentle.nad\nswap 4 MON to USDC`, `swap 2 USDC to MON, send 1 MON to ${A}, send 1 USDC to gentle.nad, swap 4 MON to USDC`, 4],
  ])("%s", (input, planText, actions) => {
    expect(toPlanText(input)).toBe(planText);
    expect(analyzePlanRequest(planText)).toEqual({ kind: "multi", actions });
  });

  it("leaves anything it doesn't recognise exactly as typed", () => {
    for (const t of ["send 1 MON to gentle.nad", "pay my landlord 5 USDC and swap 1 MON to USDC", "buy 5 MON with USDC"]) expect(normalizeClauses(t)).toBe(t);
  });

  it("never rewrites a bare word as a recipient", () => {
    expect(normalizeClauses("pay alice 2 USDC, swap 1 MON to USDC")).toBe("pay alice 2 USDC, swap 1 MON to USDC");
  });
});
