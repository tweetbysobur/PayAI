import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tokenTradeMessage } from "@/components/ask/OperationCard";

/**
 * Buy / Sell on the token intelligence card — pasting a contract address
 * shows the token with its own trade controls (bought with MON or USDC, sold
 * into MON). Source-level assertions for the wiring and safety properties,
 * matching this repo's existing approach for component wiring (see
 * ask-mark.test.ts), plus the real classifier for every message it sends.
 */

const operationCardSrc = readFileSync(new URL("../components/ask/OperationCard.tsx", import.meta.url), "utf8");
const chatMessageSrc = readFileSync(new URL("../components/ask/ChatMessage.tsx", import.meta.url), "utf8");
const askPageSrc = readFileSync(new URL("../app/dashboard/ask/page.tsx", import.meta.url), "utf8");
const commandBarSrc = readFileSync(new URL("../components/dashboard/CommandBar.tsx", import.meta.url), "utf8");

const panelSrc = operationCardSrc.slice(
  operationCardSrc.indexOf("function TokenTradePanel("),
  operationCardSrc.indexOf("/**\n * A real, just-fetched trade quote."),
);
const TOKEN = "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";

describe("the token card's Buy / Sell controls only ever send a chat message", () => {
  it("is rendered only for a tradable token, and only when onQuickAction is wired", () => {
    expect(operationCardSrc).toMatch(/\{onQuickAction && d\.isTradable && \(\s*<TokenTradePanel /);
  });

  it("touches no signing, execution or wallet API — onQuickAction is the only thing it calls", () => {
    expect(panelSrc).not.toMatch(/sendTransaction|signTransaction|writeContract|execute\w*\(|fetch\(/);
    // The review button's submit() is the one place it calls onQuickAction,
    // once, guarded against a second tap.
    expect(panelSrc).toMatch(/onClick=\{submit\}/);
    expect(panelSrc).toMatch(/function submit\(\) \{\s*if \(!message \|\| sentAt\) return;\s*setSentAt\(Date\.now\(\)\);\s*onQuickAction\(message\);/);
    expect((panelSrc.match(/onQuickAction\(/g) ?? []).length).toBe(1);
    // Every other click only changes the panel's own local state.
    const onClicks = [...panelSrc.matchAll(/onClick=\{([^}]*\}?)\}/g)].map((m) => m[1]);
    for (const oc of onClicks) expect(oc).toMatch(/^submit$|set(Side|Pay|Amount|Percent)\(|^onPick$/);
  });

  it("the review button is disabled until the request is complete, and briefly after a tap", () => {
    expect(panelSrc).toMatch(/disabled=\{!message \|\| !!sentAt\}/);
  });

  it("a sell is only blocked when the balance is read as zero — an unread balance is left to the quote", () => {
    expect(panelSrc).toMatch(/const holdsNone = side === "sell" && held === 0;/);
  });

  it("Refresh re-sends the token's own address, not a hardcoded string", () => {
    expect(operationCardSrc).toMatch(/onClick=\{\(\) => onQuickAction\(intent\.address\)\}/);
  });
});

describe("tokenTradeMessage writes requests the trading rules read exactly", () => {
  it("buy: amount and the chosen MON or USDC", () => {
    expect(tokenTradeMessage("buy", TOKEN, { amount: "10", pay: "MON" })).toBe(`Buy ${TOKEN} with 10 MON`);
    expect(tokenTradeMessage("buy", TOKEN, { amount: "5", pay: "USDC" })).toBe(`Buy ${TOKEN} with 5 USDC`);
  });
  it("sell: a percentage, all, or an exact amount", () => {
    expect(tokenTradeMessage("sell", TOKEN, { percent: 50 })).toBe(`Sell 50% of ${TOKEN}`);
    expect(tokenTradeMessage("sell", TOKEN, { percent: 100 })).toBe(`Sell all of ${TOKEN}`);
    expect(tokenTradeMessage("sell", TOKEN, { amount: "1200" })).toBe(`Sell 1200 of ${TOKEN}`);
  });
  it("normalizes how the amount is written, never its value", () => {
    expect(tokenTradeMessage("buy", TOKEN, { amount: "007", pay: "MON" })).toBe(`Buy ${TOKEN} with 7 MON`);
    expect(tokenTradeMessage("buy", TOKEN, { amount: ".5", pay: "USDC" })).toBe(`Buy ${TOKEN} with 0.5 USDC`);
    expect(tokenTradeMessage("sell", TOKEN, { amount: "12." })).toBe(`Sell 12 of ${TOKEN}`);
  });

  it("nothing for an empty, zero or malformed amount", () => {
    for (const amount of ["", "0", "0.0", ".", "1.2.3", "abc"]) {
      expect(tokenTradeMessage("buy", TOKEN, { amount, pay: "MON" }), amount).toBeNull();
      expect(tokenTradeMessage("sell", TOKEN, { amount }), amount).toBeNull();
    }
  });
});

describe("every message the card sends is a complete trade, answered by the deterministic rules", () => {
  const CASES: [string, Record<string, unknown>][] = [
    [`Buy ${TOKEN} with 10 MON`, { tradeAction: "buy", fromAsset: "MON", toAsset: TOKEN, amount: "10", amountType: "exact_input" }],
    [`Buy ${TOKEN} with 5 USDC`, { tradeAction: "buy", fromAsset: "USDC", toAsset: TOKEN, amount: "5", amountType: "exact_input" }],
    [`Sell 25% of ${TOKEN}`, { tradeAction: "sell", fromAsset: TOKEN, toAsset: "MON", amount: "25", amountType: "percentage" }],
    [`Sell all of ${TOKEN}`, { tradeAction: "sell", fromAsset: TOKEN, toAsset: "MON", amountType: "balance_all" }],
    [`Sell 1200 of ${TOKEN}`, { tradeAction: "sell", fromAsset: TOKEN, toAsset: "MON", amount: "1200", amountType: "exact_input" }],
  ];
  for (const [text, expected] of CASES) {
    it(text.replace(TOKEN, "<token>"), async () => {
      const { routeRequest } = await import("@/lib/ask/intent/classify");
      const r = await routeRequest(text, null);
      expect(r.anthropic).toBe(false);
      const u = r.understanding;
      expect(u?.kind).toBe("trade");
      expect(u?.outcome).toBe("complete");
      if (u?.kind === "trade" && u.outcome === "complete") expect(u.slots).toMatchObject(expected);
    });
  }
});

describe("onQuickAction is threaded end-to-end, not just defined in isolation", () => {
  it("OperationCard accepts onQuickAction and forwards it into IntentBody / TokenIntelligenceBody", () => {
    expect(operationCardSrc).toMatch(/onQuickAction\?:\s*\(text: string\) => void/);
    expect(operationCardSrc).toMatch(/<IntentBody intent=\{intent\} onQuickAction=\{onQuickAction\} \/>/);
    expect(operationCardSrc).toMatch(/<TokenIntelligenceBody intent=\{intent\} onQuickAction=\{onQuickAction\} \/>/);
  });

  it("ChatMessageRow accepts onQuickAction and passes it straight into OperationCard", () => {
    expect(chatMessageSrc).toMatch(/onQuickAction\?:\s*\(text: string\) => void/);
    expect(chatMessageSrc).toMatch(/onQuickAction=\{onQuickAction\}/);
  });

  it("both real call sites wire the same send() the empty-state capability tiles already use -- no new backend path", () => {
    expect(askPageSrc).toMatch(/onQuickAction=\{send\}/);
    expect(commandBarSrc).toMatch(/onQuickAction=\{chat\.send\}/);
  });
});

describe("typed shortcuts are still understood", () => {
  for (const label of ["Buy this token", "Sell this token"]) {
    it(`"${label}" resolves to a trade, never unclear`, async () => {
      const { understand } = await import("@/lib/ask/intent/classify");
      const u = await understand(label, [], null);
      expect(u.kind).toBe("trade");
      expect(u.outcome).not.toBe("unclear");
    });
  }
});
