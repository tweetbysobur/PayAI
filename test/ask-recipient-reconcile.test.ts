import { describe, expect, it } from "vitest";
import { reconcileRecipient } from "@/lib/ask/intent/classify";
import type { Understanding } from "@/lib/ask/intent/types";

const ADDR = "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a";
const empty = { amount: null, asset: null, recipient: null, when: null, frequency: null, fromAsset: null, toAsset: null, recipientCount: null, txHash: null, tokenAddress: null, tradeAction: null, amountType: null, slippage: null };
const text = `send 1 usdc to ${ADDR}`;
const parsed = { kind: "send_payment", outcome: "complete", slots: { ...empty, amount: "1", asset: "USDC", recipient: ADDR } } as Understanding;
const modelMiscount = { kind: "send_payment", outcome: "incomplete", slots: { ...empty, amount: "1", asset: "USDC" }, question: "That wallet address looks off, it has too many characters." } as Understanding;

describe("reconcileRecipient", () => {
  it("keeps a well-formed address the user typed when the model drops it", () => {
    expect(reconcileRecipient(modelMiscount, parsed, text)).toEqual({ kind: "send_payment", outcome: "complete", slots: { ...empty, amount: "1", asset: "USDC", recipient: ADDR } });
  });
  it("still asks for what is missing", () => {
    const m = { ...modelMiscount, slots: { ...empty, asset: "USDC" } } as Understanding;
    const r = reconcileRecipient(m, parsed, text);
    expect(r.outcome).toBe("incomplete");
    expect(r.outcome === "incomplete" && r.slots.recipient).toBe(ADDR);
  });
  it("never adds a recipient the user didn't type", () => {
    expect(reconcileRecipient(modelMiscount, parsed, "send 1 usdc to my friend")).toBe(modelMiscount);
  });
  it("leaves a different kind of request alone", () => {
    const swap = { ...modelMiscount, kind: "swap" } as Understanding;
    expect(reconcileRecipient(swap, parsed, text)).toBe(swap);
  });
  it("leaves the model's own recipient alone", () => {
    const m = { ...parsed, slots: { ...(parsed as Extract<Understanding, { outcome: "complete" }>).slots, recipient: "bob.nad" } } as Understanding;
    expect(reconcileRecipient(m, parsed, `${text} bob.nad`)).toBe(m);
  });
});
