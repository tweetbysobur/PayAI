import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationCard, displayStatus, hasNextRun, lastResult } from "@/components/dashboard/AutomationCard";
import type { Automation, Run } from "@/components/dashboard/automationShared";

/**
 * Fixture tests for the Automations page's card. The local test wallet has no
 * automation history, so each supported state is built here in memory — no
 * production records, no API calls, nothing executed. Every field used is one
 * the real Automation type has; no state the system doesn't support.
 */

const DAY = 86_400_000;
const NOW = Date.now();
const ADDR = "0x1111111111111111111111111111111111111111";

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: "auto_1", amount: 20, token: "USDC", recipient: ADDR, domain: "bob.nad",
    cadence: "weekly", nextRun: NOW + 2 * DAY, status: "active",
    createdAt: NOW - 30 * DAY, runs: [], purpose: "Weekly allowance",
    runsCompleted: 0, failureCount: 0, lastError: null, fundingMode: "wallet",
    ...over,
  } as Automation;
}
const run = (decision: string, at = NOW - DAY, extra: Partial<Run> = {}): Run => ({ at, decision, txHash: "0xabc", ...extra });

const noop = () => {};
function render(a: Automation) {
  return renderToStaticMarkup(createElement(AutomationCard, {
    automation: a, busy: false, onAction: noop, onView: noop, onEdit: noop, onDuplicate: noop,
  }));
}
/** The accessible action labels present in the card. */
const actions = (html: string) => [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("never-run automations", () => {
  it("say \"Not run yet\" and show no success rate of any kind", () => {
    const html = render(auto());
    expect(text(html)).toMatch(/Last result Not run yet/);
    expect(html).not.toMatch(/%|Success Rate|success rate/i);
    expect(lastResult(auto())).toEqual({ label: "Not run yet", tone: "text-muted-foreground" });
  });
});

describe("each supported status", () => {
  it("running (active, next run ahead): shows the next run, Details/Edit and every live action", () => {
    const html = render(auto({ runs: [run("executed")], runsCompleted: 1 }));
    expect(text(html)).toMatch(/Details Edit/);
    expect(text(html)).toMatch(/Waiting/);
    expect(text(html)).toMatch(/Next run \w{3}, \w{3} \d+/);
    expect(text(html)).toMatch(/Last result Sent · /);
    expect(actions(html)).toEqual(["Pause", "Execute Now", "Skip Next", "Duplicate", "Cancel", "Delete"]);
  });

  it("executing: labelled as executing, with no run-now/skip offered mid-run", () => {
    const html = render(auto({ status: "executing" }));
    expect(text(html)).toMatch(/Executing/);
    expect(actions(html)).toEqual(["Pause", "Duplicate", "Cancel", "Delete"]);
  });

  it("paused: offers Resume (not Pause), and no next run is claimed", () => {
    const html = render(auto({ status: "paused" }));
    expect(text(html)).toMatch(/Paused/);
    expect(text(html)).toMatch(/Next run —/);
    expect(actions(html)).toEqual(["Resume", "Duplicate", "Cancel", "Delete"]);
  });

  it("failed: says so, shows the recorded reason, and offers Resume", () => {
    const html = render(auto({ status: "failed", failureCount: 3, lastError: "Insufficient USDC allowance for the executor.", runs: [run("error")] }));
    expect(text(html)).toMatch(/Failed/);
    expect(text(html)).toMatch(/Insufficient USDC allowance for the executor\./);
    expect(text(html)).toMatch(/Last result Failed · /);
    expect(actions(html)).toContain("Resume");
  });

  it("retrying (active with consecutive failures): labelled as retrying with the reason shown", () => {
    const html = render(auto({ failureCount: 1, lastError: "RPC timeout", nextRun: NOW - 1000, runs: [run("error")] }));
    expect(text(html)).toMatch(/Retrying/);
    expect(text(html)).toMatch(/RPC timeout/);
  });

  it("completed and cancelled: only Details, Duplicate and Delete — nothing that implies it can still run", () => {
    for (const status of ["completed", "cancelled"] as const) {
      const html = render(auto({ status, runs: [run("executed")], runsCompleted: 4 }));
      expect(actions(html), status).toEqual(["Duplicate", "Delete"]);
      expect(text(html), status).toMatch(/Details/);
      expect(text(html), status).not.toMatch(/\bEdit\b/);
      expect(text(html), status).toMatch(/Next run —/);
    }
  });

  it("reserved-funds refund states use the explicit refund status, never a guess", () => {
    expect(displayStatus(auto({ status: "cancelled", fundingMode: "reserved", reserveRefundStatus: "pending" })).label).toBe("refunding");
    expect(displayStatus(auto({ status: "cancelled", fundingMode: "reserved", reserveRefundStatus: "refunded" })).label).toBe("refunded");
    expect(displayStatus(auto({ status: "cancelled", fundingMode: "reserved" })).label).toBe("cancelled");
    expect(text(render(auto({ fundingMode: "reserved" })))).toMatch(/Reserved funds/);
  });
});

describe("missing or odd data stays honest", () => {
  it("a live automation with no usable next-run time says \"Not scheduled\", never \"Invalid Date\"", () => {
    for (const nextRun of [0, Number.NaN, undefined as unknown as number]) {
      const html = render(auto({ nextRun }));
      expect(hasNextRun({ nextRun })).toBe(false);
      expect(text(html)).toMatch(/Next run Not scheduled/);
      expect(html).not.toMatch(/Invalid Date/);
    }
  });

  it("no purpose or memo falls back to \"Automation\"", () => {
    expect(text(render(auto({ purpose: undefined, memo: undefined })))).toMatch(/^ ?Automation /);
  });

  it("a recipient with no .nad name shows the shortened address", () => {
    expect(text(render(auto({ domain: null })))).toMatch(/0x1111\.\.\.1111/);
  });
});

describe("bulk payments", () => {
  it("show the recipient count and real paid / failed totals from recorded runs", () => {
    const html = render(auto({
      purpose: "Contributor payroll", cadence: "monthly",
      recipients: [{ input: "a.nad", address: ADDR, amount: 10 }, { input: "b.nad", address: ADDR, amount: 10 }, { input: "c.nad", address: ADDR, amount: 10 }],
      runs: [run("partial", NOW - DAY, { recipientResults: [
        { address: ADDR, amount: 10, decision: "executed" }, { address: ADDR, amount: 10, decision: "executed" }, { address: ADDR, amount: 10, decision: "error" },
      ] })],
    }));
    expect(text(html)).toMatch(/3 recipients/);
    expect(text(html)).toMatch(/Paid \/ failed 2 \/ 1/);
    expect(text(html)).toMatch(/Last result Partly sent/);
    // Duplicate isn't supported for bulk payments — offered disabled with the reason, as before.
    expect(actions(html)).toContain("Duplicate (not supported for bulk payments yet)");
    expect(text(html)).not.toMatch(/\bEdit\b/);
  });
});

describe("layout safeguards for long values", () => {
  it("long names wrap instead of overflowing; large amounts are formatted", () => {
    const html = render(auto({
      purpose: "A very long automation purpose describing exactly which contributors receive what on which day of the month",
      domain: "a-really-long-recipient-name-that-keeps-going-and-going.nad",
      amount: 123456789.1234,
    }));
    expect(html).toMatch(/class="[^"]*break-words[^"]*"[^>]*>A very long automation purpose/);
    expect(html).toMatch(/class="[^"]*break-all[^"]*"[^>]*>a-really-long-recipient-name/);
    expect(text(html)).toMatch(/123,456,789\.1234 USDC/);
  });
});
