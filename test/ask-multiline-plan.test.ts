import { describe, expect, it } from "vitest";
import { analyzePlanRequest, joinActionLines, toPlanText } from "@/lib/ask/planFastPath";
import { parseIntent } from "@/lib/plan-adapter/grammar";

const tokens = { monDecimals: 18, stable: { symbol: "USDC", decimals: 6 } };
const A = "0x0264538c189fdfccfe233fb1413e444f81638f7f";
const B = "0x588b4b342132bfcb31e7ba7ee1b108e0e9859a87";
const C = "0x25b84164461fe6ea4dab470460d0c4eb7c7fdc3a";

/** One action per line — how people write a list on a phone. */
describe("multi-action requests written one per line", () => {
  it("reads the reported message as a swap and three sends, in order", () => {
    const msg = `Swap 1 USDC  to MON and  \n\nsend 1 MON to ${A}\n\nsend 2 MON to ${B}\n\nsend 4 MON to ${C}`;
    const text = toPlanText(msg);
    expect(analyzePlanRequest(text)).toEqual({ kind: "multi", actions: 4 });
    const r = parseIntent(text, tokens);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps.map((s) => s.kind)).toEqual(["swap", "transfer", "transfer", "transfer"]);
    expect(r.steps.slice(1).map((s) => (s.kind === "transfer" ? s.recipient.display : ""))).toEqual([A, B, C]);
    expect(r.steps.slice(1).map((s) => (s.kind === "transfer" && s.amount.kind === "units" ? s.amount.units : ""))).toEqual([
      "1000000000000000000", "2000000000000000000", "4000000000000000000",
    ]);
  });

  it("accepts list markers and numbered lists", () => {
    expect(joinActionLines(`- send 1 MON to ${A}\n- send 2 MON to ${B}`)).toBe(`send 1 MON to ${A}, send 2 MON to ${B}`);
    expect(joinActionLines(`1. swap 5 MON to USDC\n2) send 1 USDC to ${A}`)).toBe(`swap 5 MON to USDC, send 1 USDC to ${A}`);
  });

  it("keeps an explicit connector instead of adding a comma", () => {
    expect(joinActionLines(`swap 1 USDC to MON then\nsend 1 MON to ${A}`)).toBe(`swap 1 USDC to MON then send 1 MON to ${A}`);
  });

  it("joins a sentence wrapped onto the next line back together", () => {
    expect(joinActionLines(`send 1 MON to\n${A}`)).toBe(`send 1 MON to ${A}`);
  });

  it("leaves a single line untouched", () => {
    expect(joinActionLines(`send 1 MON to ${A}`)).toBe(`send 1 MON to ${A}`);
  });

  it("never changes an amount, token or recipient", () => {
    const joined = joinActionLines(`send 1.25 USDC to ${A}\nsend 0.5 MON to bob.nad`);
    expect(joined).toContain(`1.25 USDC to ${A}`);
    expect(joined).toContain("0.5 MON to bob.nad");
  });
});

/** The everyday ways of writing the same actions all reach the same plan. */
describe("separators, verbs and number formats people actually type", () => {
  const steps = (msg: string) => {
    const r = parseIntent(toPlanText(msg), tokens);
    if (!r.ok) throw new Error(`${msg} -> ${r.code}`);
    return r.steps.map((s) =>
      s.kind === "swap" ? `swap ${s.amountIn} ${s.tokenIn}->${s.tokenOut}`
        : `send ${s.amount.kind === "units" ? s.amount.units : "output"} ${s.token} to ${s.recipient.display}`);
  };
  const ONE = "1000000000000000000", TWO = "2000000000000000000";

  for (const [label, msg] of [
    ["no separator", `swap 1 USDC to MON send 1 MON to ${A} send 2 MON to ${B}`],
    ["semicolons", `swap 1 USDC to MON; send 1 MON to ${A}; send 2 MON to ${B}`],
    ["full stops", `Swap 1 USDC to MON. Send 1 MON to ${A}. Send 2 MON to ${B}.`],
    ["ampersands and also", `swap 1 USDC to MON & send 1 MON to ${A} also send 2 MON to ${B}`],
    ["convert and transfer", `convert 1 USDC to MON then transfer 1 MON to ${A} and transfer 2 MON to ${B}`],
  ] as const) {
    it(`${label}: same swap and two sends`, () => {
      expect(steps(msg)).toEqual([`swap 1000000 STABLE->MON`, `send ${ONE} MON to ${A}`, `send ${TWO} MON to ${B}`]);
    });
  }

  it("number formats keep their exact value", () => {
    expect(steps(`send .5 MON to ${A}`)).toEqual([`send 500000000000000000 MON to ${A}`]);
    expect(steps(`send 1,000 MON to ${A}`)).toEqual([`send 1000000000000000000000 MON to ${A}`]);
    expect(steps(`send 1mon to ${A}`)).toEqual([`send ${ONE} MON to ${A}`]);
  });

  it("recipient wording and arrows", () => {
    expect(steps(`send 1 MON to address ${A}`)).toEqual([`send ${ONE} MON to ${A}`]);
    expect(steps(`send 1 MON to wallet ${B}`)).toEqual([`send ${ONE} MON to ${B}`]);
    expect(steps(`send 1 MON → ${A}`)).toEqual([`send ${ONE} MON to ${A}`]);
  });

  it("a list in a sentence is not split, and an amount is never split by a comma", () => {
    // "1,5" is not a thousands group: left alone, so the grammar refuses it rather than guess.
    expect(parseIntent(toPlanText(`send 1,5 MON to ${A}`), tokens).ok).toBe(false);
  });
});

describe("sending what a swap returned, however it's said", () => {
  for (const m of [
    "Swap 1 MON to USDC and send the usdc to gentle.nad",
    "Swap 1 MON to USDC and send it to gentle.nad",
    "swap 1 MON to USDC and send that to gentle.nad",
    "swap 1 MON to USDC then send them to gentle.nad",
    "swap 1 MON to USDC and send the proceeds to gentle.nad",
  ]) {
    it(m, () => {
      const r = parseIntent(toPlanText(m), tokens);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.steps[1]).toMatchObject({ kind: "transfer", token: "STABLE", amount: { kind: "output", step: 0 }, recipient: { display: "gentle.nad" } });
    });
  }
});
