import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handoffStep, HANDOFF_MAX_CHARS } from "@/lib/ask/handoff";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("Dashboard → Ask hand-off rules", () => {
  const idle = { messageCount: 0, thinking: false };

  it("sends the person's exact intent (trimmed) as the first message of an empty, idle conversation", () => {
    expect(handoffStep("  Send 200 USDC to john.nad tomorrow  ", idle)).toEqual({ kind: "send", text: "Send 200 USDC to john.nad tomorrow" });
    const long = Array.from({ length: 50 }, (_, i) => `send 1 MON to a${i}.nad`).join(", ");
    expect(handoffStep(long, idle)).toEqual({ kind: "send", text: long });
  });

  it("never sends into a conversation that already has messages — it resets to a fresh one first", () => {
    expect(handoffStep("swap 1 MON to USDC", { messageCount: 4, thinking: false })).toEqual({ kind: "reset" });
  });

  it("waits while a turn is running", () => {
    expect(handoffStep("swap 1 MON to USDC", { messageCount: 0, thinking: true })).toEqual({ kind: "wait" });
    expect(handoffStep("swap 1 MON to USDC", { messageCount: 3, thinking: true })).toEqual({ kind: "wait" });
  });

  it.each(["yes", "Yes!", "confirm", "do it", "go ahead", "yes, send it.", "proceed"])("never submits a bare affirmation (%j) — it is only placed in the composer", (text) => {
    expect(handoffStep(text, idle)).toEqual({ kind: "prefill", text: text.trim() });
  });

  it("drops empty or oversized input", () => {
    expect(handoffStep("   ", idle)).toEqual({ kind: "drop" });
    expect(handoffStep("x".repeat(HANDOFF_MAX_CHARS + 1), idle)).toEqual({ kind: "drop" });
  });
});

describe("the hand-off adds no execution path", () => {
  it("the intent box only hands off and navigates", () => {
    const entry = read("components/dashboard/AskEntry.tsx");
    expect(entry).toMatch(/startIntent\(intent\)/);
    expect(entry).toMatch(/router\.push\("\/dashboard\/ask"\)/);
    expect(entry).not.toMatch(/\bsend\(|sendTransaction|waitForReceipt|runPlanInApp|approvePlan|createPlan|advanceOperation/);
  });

  it("the provider submits only through Ask's own send(), after starting a fresh conversation", () => {
    const ctx = read("lib/ask/AskPageChatContext.tsx");
    expect(ctx).toMatch(/handoffStep\(text, \{ messageCount: messages\.length, thinking \}\)/);
    expect(ctx).toMatch(/if \(step\.kind === "reset"\) \{ newConversation\(\); return; \}/);
    expect(ctx).toMatch(/if \(step\.kind === "send"\) void send\(step\.text\);/);
    expect(ctx).not.toMatch(/advanceOperation|retryOperation|approvePlan|runPlanInApp|sendTransaction|waitForReceipt/);
  });

  it("the Dashboard itself never calls Ask's send or any signing API", () => {
    const page = read("app/dashboard/page.tsx");
    expect(page).not.toMatch(/useAskPageChat|\bsend\(|sendTransaction|waitForReceipt|eth_sendTransaction|personal_sign|signTypedData/);
  });
});
