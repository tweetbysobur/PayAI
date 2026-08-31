import { describe, expect, it } from "vitest";
import { guessThinkingLabel } from "@/lib/ask/useAskChat";

/**
 * P1.5 — Step 6 (speed & latency): a bare "…" dots row reads as frozen no
 * matter what's actually happening. guessThinkingLabel is a pure,
 * display-only heuristic (never touches classification or execution) that
 * picks a more specific label for the "thinking" row between the user's
 * message and PayAI's reply. Every case here mirrors an example the product
 * brief itself names ("Preparing your trade…", "Checking the token…", …).
 */
describe("guessThinkingLabel — display-only loading copy, never a classification decision", () => {
  it("a pasted contract address gets the token-specific label", () => {
    expect(guessThinkingLabel("what's this, 0x1234567890abcdef1234567890abcdef12345678")).toBe("Checking the token…");
  });

  it("a trade/swap request gets the trade-specific label", () => {
    expect(guessThinkingLabel("Buy this token with 20 USDC")).toBe("Preparing your trade…");
    expect(guessThinkingLabel("swap 0.2 MON for USDC")).toBe("Preparing your trade…");
  });

  it("a payment request gets the payment-specific label", () => {
    expect(guessThinkingLabel("Send 100 USDC to Alex")).toBe("Preparing your payment…");
  });

  it("a transaction-status question gets the confirming-on-Monad label", () => {
    expect(guessThinkingLabel("did my last payment go through?")).toBe("Checking Monad…");
  });

  it("a balance/history question gets the wallet-check label", () => {
    expect(guessThinkingLabel("show me my recent transactions")).toBe("Checking your wallet…");
    expect(guessThinkingLabel("what's my balance")).toBe("Checking your wallet…");
  });

  it("an unrecognized shape falls back to null (plain animated dots) rather than guessing", () => {
    expect(guessThinkingLabel("hello there")).toBeNull();
    expect(guessThinkingLabel("what is PayAI?")).toBeNull();
  });

  it("a pasted address always wins over a trade/payment word appearing in the same message", () => {
    expect(guessThinkingLabel("is this safe to buy, 0x1234567890abcdef1234567890abcdef12345678")).toBe("Checking the token…");
  });
});
