import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Buy/Sell/Refresh quick actions on the token intelligence card — the
 * TG-trading-bot-style shortcut so pasting a CA doesn't require typing a
 * follow-up. Source-level assertions, matching this repo's existing
 * approach for component wiring (see ask-mark.test.ts).
 */

const operationCardSrc = readFileSync(new URL("../components/ask/OperationCard.tsx", import.meta.url), "utf8");
const chatMessageSrc = readFileSync(new URL("../components/ask/ChatMessage.tsx", import.meta.url), "utf8");
const askPageSrc = readFileSync(new URL("../app/dashboard/ask/page.tsx", import.meta.url), "utf8");
const commandBarSrc = readFileSync(new URL("../components/dashboard/CommandBar.tsx", import.meta.url), "utf8");

describe("token intelligence quick actions only ever re-send a message", () => {
  it("Buy and Sell call onQuickAction with the exact phrasing the trade classifier already understands", () => {
    expect(operationCardSrc).toMatch(/onClick=\{\(\) => onQuickAction\("Buy this token"\)\}/);
    expect(operationCardSrc).toMatch(/onClick=\{\(\) => onQuickAction\("Sell this token"\)\}/);
  });

  it("Refresh re-sends the token's own address, not a hardcoded string", () => {
    expect(operationCardSrc).toMatch(/onClick=\{\(\) => onQuickAction\(intent\.address\)\}/);
  });

  it("Buy/Sell are gated on d.isTradable -- never offered for a token with no route", () => {
    const block = operationCardSrc.slice(
      operationCardSrc.indexOf("Quick actions"),
      operationCardSrc.indexOf("{d.nadFun &&"),
    );
    expect(block).toMatch(/\{d\.isTradable && \(/);
    // Buy/Sell must be inside the isTradable-gated branch, Refresh outside it.
    const isTradableIdx = block.indexOf("d.isTradable && (");
    const buyIdx = block.indexOf('"Buy this token"');
    const refreshIdx = block.indexOf("intent.address)}");
    expect(buyIdx).toBeGreaterThan(isTradableIdx);
    expect(refreshIdx).toBeGreaterThan(buyIdx);
  });

  it("the whole quick-action row is gated on onQuickAction being provided, so a caller that never wires it renders nothing new", () => {
    expect(operationCardSrc).toMatch(/\{onQuickAction && \(\s*<div className="mb-2\.5 flex items-center gap-2">/);
  });

  it("no quick-action button touches signing, execution, or wallet APIs directly -- onQuickAction is the only call any of them make", () => {
    const start = operationCardSrc.indexOf("{onQuickAction && (");
    const end = operationCardSrc.indexOf("{d.nadFun &&");
    const block = operationCardSrc.slice(start, end);
    expect(block).not.toMatch(/sendTransaction|signTransaction|writeContract|execute\w*\(/);
    // Every onClick in this block must be a bare onQuickAction(...) call.
    const onClicks = [...block.matchAll(/onClick=\{([^}]*)\}/g)].map((m) => m[1]);
    expect(onClicks.length).toBeGreaterThanOrEqual(3);
    for (const oc of onClicks) expect(oc).toMatch(/^\(\) => onQuickAction\(/);
  });
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

describe("every shortcut label the quick actions send is actually understood by the real classifier", () => {
  // Same discipline as ask-mark.test.ts's capability-tile check: run the real
  // pipeline with no API key (the worst case -- production reaches Anthropic
  // for all of these), so passing here means the button never dead-ends.
  const CASES: [string, string][] = [
    ["Buy this token", "trade"],
    ["Sell this token", "trade"],
  ];

  for (const [label, kind] of CASES) {
    it(`"${label}" resolves to ${kind}, never unclear`, async () => {
      const { understand } = await import("@/lib/ask/intent/classify");
      const u = await understand(label, [], null);
      expect(u.kind).toBe(kind);
      expect(u.outcome).not.toBe("unclear");
    });
  }
});
