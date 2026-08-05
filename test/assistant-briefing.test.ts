import { describe, it, expect } from "vitest";
import { greeting, OPERATOR_ACTIONS, type AssistantContext } from "@/components/dashboard/AssistantBriefing";

/**
 * The greeting is the assistant's first claim about the user's account, and a
 * wrong one is worse than a generic one. It must never congratulate an empty
 * account on its operation, never announce a payment that isn't scheduled, and
 * never bury the fact that something is broken under a friendly line.
 */
function ctx(over: Partial<AssistantContext> = {}): AssistantContext {
  return {
    known: true,
    balance: { mon: 2, usdc: 100 },
    linkedWallets: [],
    automations: { live: 0, total: 0, needsAttention: 0, next: null },
    activity: { settledPayments: 0, recentSwaps: [] },
    notifications: { recent: 0 },
    templates: [],
    ...over,
  };
}

describe("assistant greeting", () => {
  it("does not pretend to know an account it has no wallet for", () => {
    const { title, detail } = greeting(null);
    expect(title).toMatch(/Welcome to PayAI/);
    expect(detail).toMatch(/Connect a wallet/);
  });

  it("treats an unknown context the same as no context", () => {
    expect(greeting({ ...ctx(), known: false }).detail).toMatch(/Connect a wallet/);
  });

  it("asks what to automate when there is nothing to report", () => {
    expect(greeting(ctx()).detail).toBe("What would you like to automate today?");
  });

  it("leads with what is broken, ahead of anything else", () => {
    // A failed automation outranks a friendly prompt and even an upcoming
    // payment: it is the only thing here the user must act on.
    const g = greeting(ctx({
      automations: {
        live: 3, total: 4, needsAttention: 2,
        next: { id: "a1", at: Date.now() + 3_600_000, amount: 10, token: "USDC", recipient: "alice.nad" },
      },
    }));
    expect(g.detail).toMatch(/2 automations need your attention/);
  });

  it("names the next payment when one is scheduled", () => {
    const g = greeting(ctx({
      automations: {
        live: 1, total: 1, needsAttention: 0,
        next: { id: "a1", at: Date.now() + 2 * 3_600_000, amount: 250, token: "USDC", recipient: "payroll.nad" },
      },
    }));
    expect(g.detail).toMatch(/250 USDC to payroll\.nad/);
    expect(g.detail).toMatch(/in 2h/);
  });

  it("says a payment is due now rather than reporting a negative time", () => {
    const g = greeting(ctx({
      automations: {
        live: 1, total: 1, needsAttention: 0,
        next: { id: "a1", at: Date.now() - 60_000, amount: 5, token: "MON", recipient: "bob.nad" },
      },
    }));
    expect(g.detail).toMatch(/due now/);
    expect(g.detail).not.toMatch(/-/);
  });

  it("reports running automations when none has a next run yet", () => {
    const g = greeting(ctx({ automations: { live: 2, total: 2, needsAttention: 0, next: null } }));
    expect(g.detail).toMatch(/2 automations running/);
  });

  it("uses singular wording for a single item", () => {
    expect(greeting(ctx({ automations: { live: 1, total: 1, needsAttention: 1, next: null } })).detail)
      .toMatch(/1 automation needs your attention/);
    expect(greeting(ctx({ automations: { live: 1, total: 1, needsAttention: 0, next: null } })).detail)
      .toMatch(/1 automation running/);
  });
});

describe("assistant briefing — a partly-known balance", () => {
  it("still reports MON when USDC is not configured on this deployment", () => {
    // Hiding both figures because one is missing throws away a fact the user
    // has, on the asset nothing on this chain works without.
    const c = ctx({ balance: { mon: 4.2, usdc: null } });
    expect(c.balance?.mon).toBe(4.2);
    expect(c.balance?.usdc).toBeNull();
  });
});

describe("operator actions", () => {
  it("offers every operation the sprint asked for", () => {
    const labels = OPERATOR_ACTIONS.map((a) => a.label);
    expect(labels).toEqual([
      "Create Automation",
      "Send Payment",
      "Swap Tokens",
      "Schedule Payroll",
      "Run Distribution",
      "Check Upcoming Payments",
      "Review Treasury",
    ]);
  });

  it("gives every action somewhere real to go", () => {
    // An action that neither navigates nor fills the prompt is a dead button.
    for (const action of OPERATOR_ACTIONS) {
      expect(action.href ?? action.prompt, `${action.label} does nothing`).toBeTruthy();
    }
  });

  it("leaves a prompt needing a recipient unfinished rather than inventing one", () => {
    // "send " ends with a space: the bar fills it in and waits. A complete
    // instruction would run immediately, which for a payment means running one
    // to a recipient nobody named.
    const send = OPERATOR_ACTIONS.find((a) => a.label === "Send Payment");
    expect(send?.prompt).toMatch(/ $/);
  });
});
