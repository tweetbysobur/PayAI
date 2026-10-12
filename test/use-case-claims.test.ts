import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findTemplate, workflowStatus } from "@/lib/automation/templates";

/**
 * The /product use-case cards make claims about real money flows. These pin
 * them to what the code does: a Bulk payment is one transaction per
 * recipient (lib/automation/execute.ts), and the business/bulk/launchpad
 * templates are not finished.
 */
const src = readFileSync("components/landing/PlatformOverview.tsx", "utf8");

describe("use-case cards", () => {
  it("never promise a single batched transaction or guaranteed dates", () => {
    expect(src).not.toMatch(/never miss a date|one transaction to (all|every)|in one transaction|vested releases|revenue splits/i);
  });

  it("say bulk runs are one transaction per recipient", () => {
    expect(src).toMatch(/One transaction per recipient, not one batched transaction/);
    expect(src).toMatch(/one transaction per recipient/);
  });

  it("only label a card as working today when it needs no unfinished template", () => {
    const ready = [...src.matchAll(/title: "([^"]+)", status: "ready"/g)].map((m) => m[1]);
    expect(ready.sort()).toEqual(["Rent and personal", "Vendor payments"]);
  });

  it("only link to templates that are available", () => {
    for (const [, id] of src.matchAll(/template: "([^"]+)"/g)) {
      const t = findTemplate(id);
      expect(t, id).toBeDefined();
      expect(workflowStatus(t!)).toBe("available");
    }
  });

  it("execution really is sequential per recipient", () => {
    const exec = readFileSync("lib/automation/execute.ts", "utf8");
    expect(exec).toMatch(/for \(let i = 0; i < recipients\.length; i\+\+\)/);
  });
});
