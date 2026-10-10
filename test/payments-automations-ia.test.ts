import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Payments & Automations is where you manage what PayAI is doing or has
 * done; Ask PayAI is where you say what you want. These guard the redesign's
 * product rules — intent first, no invented numbers — and that it added no
 * execution path.
 */
const root = join(__dirname, "..");
const raw = (p: string) => readFileSync(join(root, p), "utf8");
const code = (p: string) => raw(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const SEND = "app/dashboard/payments/page.tsx";
const AUTO = "app/dashboard/automations/page.tsx";
const HIST = "app/dashboard/transactions/page.tsx";
const RECIP = "app/dashboard/recipients/page.tsx";
const SWAP = "app/dashboard/swap/page.tsx";

describe("intent first", () => {
  it("Send leads with the Ask hand-off, and keeps the existing direct form as the alternative", () => {
    const src = code(SEND);
    expect(src).toMatch(/<AskEntry[\s\S]*?label="Send with intent"/);
    expect(src.indexOf("<AskEntry")).toBeLessThan(src.indexOf("Or send directly"));
    // The direct path is the same working one as before, not a new one.
    expect(src).toMatch(/useAgentConsole/);
  });

  it("Automations leads with 'Automate with intent' and keeps the creator, templates and bulk payments", () => {
    const src = code(AUTO);
    expect(src).toMatch(/<AskEntry[\s\S]*?label="Automate with intent"/);
    for (const kept of ["<AutomationCreator", "<BulkPaymentCreator", "<TemplatePicker", "<ReservationRecovery", "<AutomationDetail", "<AutomationEdit"]) {
      expect(src, kept).toContain(kept);
    }
  });

  it("Swap hands off to Ask rather than offering a trading form", () => {
    expect(code(SWAP)).toMatch(/<AskEntry/);
  });
});

describe("no invented numbers", () => {
  it("an automation that has never run has no success rate", () => {
    const src = code(AUTO);
    expect(src).toMatch(/successRate: attempted\.length \? Math\.round\(\(executed\.length \/ attempted\.length\) \* 100\) : null/);
    expect(src).toMatch(/m\.successRate == null \? "Not run yet"/);
    // The card (now its own component) says "Not run yet" until a run exists.
    expect(code("components/dashboard/AutomationCard.tsx")).toMatch(/if \(!last\) return \{ label: "Not run yet"/);
  });

  it("Automations has no stat tiles, health grid or trend chart", () => {
    const src = code(AUTO);
    expect(src).not.toMatch(/function Metric\b|<Metric |Automation Health|ExecutionTrendChart|Gas Spent" value=\{`\$\{totalGas/);
  });

  it("History has no headline stats (no success-rate tile defaulting to 100%)", () => {
    const src = code(HIST);
    expect(src).not.toMatch(/Payments settled|Success rate|successRate/);
  });

  it("Recipients says where saved recipients live, and does not claim Ask uses them", () => {
    const src = code(RECIP);
    expect(src).toMatch(/Saved in this browser/);
    expect(src).not.toMatch(/PayAI (uses|resolves)/i);
  });
});

describe("no new execution path", () => {
  const SIGN = /sendTransaction|waitForReceipt|eth_sendTransaction|personal_sign|signTypedData/g;
  for (const f of [SEND, AUTO, HIST, RECIP, SWAP, "app/dashboard/invoices/page.tsx"]) {
    it(`${f}: no more signing/broadcast call sites than before this redesign`, () => {
      const now = (raw(f).match(SIGN) ?? []).length;
      let before = 0;
      try { before = (execSync(`git show HEAD:${f}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).match(SIGN) ?? []).length; } catch { before = 0; }
      expect(now).toBeLessThanOrEqual(before);
    });
  }
});
