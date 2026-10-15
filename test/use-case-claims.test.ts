import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The /product page makes claims about real money flows. The use-case cards
 * (payroll, treasury, subscriptions…) were removed because those workflows
 * aren't available yet; what remains must still never over-promise, and a
 * Bulk payment really is one transaction per recipient (lib/automation/execute.ts).
 */
const src = readFileSync("components/landing/PlatformOverview.tsx", "utf8");

describe("product claims", () => {
  it("never promise a single batched transaction or guaranteed dates", () => {
    expect(src).not.toMatch(/never miss a date|one transaction to (all|every)|in one transaction|vested releases|revenue splits/i);
  });

  it("no longer carries the unfinished use-case cards", () => {
    expect(src).not.toMatch(/PaymentOperationsSection|status: "partial"|title: "Payroll"/);
  });

  it("execution really is sequential per recipient", () => {
    const exec = readFileSync("lib/automation/execute.ts", "utf8");
    expect(exec).toMatch(/for \(let i = 0; i < recipients\.length; i\+\+\)/);
  });
});
