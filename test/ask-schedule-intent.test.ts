import { describe, it, expect, beforeEach } from "vitest";
import { understandWithScheduling as understand, reconcileSchedule, missingSlots } from "@/lib/ask/intent/classify";
import { scheduleRequestText } from "@/lib/ask/intent/scheduleText";
import { parseScheduleIntent } from "@/lib/agent/brain";
import type { AskSlots, Understanding } from "@/lib/ask/intent/types";

/**
 * Regression: "Send 1 USDC to bob.nad every Friday." was answered with
 * "When should it run?".
 *
 * Root cause: understanding kept the schedule, but the request Ask handed to
 * the schedule engine was rebuilt as "Schedule 1 USDC to bob.nad every
 * weekly" — the day was dropped, and "every weekly" isn't a phrase the engine
 * reads, so it reported the time as missing. These tests pin the whole chain:
 * what the person wrote → what Ask understood → what the engine receives →
 * what the engine schedules, which must be the same schedule the original
 * words produce.
 */

beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });

const slotsOf = (u: Understanding) => (u as { slots: AskSlots }).slots;

/** The engine's reading of the request Ask would send for `u`. */
function engineReadingOf(u: Understanding) {
  const kind = u.kind as "schedule_payment" | "recurring_payment";
  const text = scheduleRequestText(kind, slotsOf(u));
  return { text, parse: parseScheduleIntent(text) };
}

describe("the six reported phrases", () => {
  it("\"Send 1 USDC to bob.nad every Friday.\" → a complete weekly automation on Fridays; nothing is asked", async () => {
    const text = "Send 1 USDC to bob.nad every Friday.";
    const u = await understand(text, [], null);
    expect(u).toMatchObject({ kind: "recurring_payment", outcome: "complete" });
    expect(slotsOf(u)).toMatchObject({ amount: "1", asset: "USDC", recipient: "bob.nad", frequency: "weekly" });
    const { text: sent, parse } = engineReadingOf(u);
    expect(sent).not.toMatch(/every weekly/);
    const original = parseScheduleIntent(text)!;
    expect(parse).toMatchObject({ cadence: "weekly", needsTime: false, nextRun: original.nextRun });
    expect(new Date(parse!.nextRun!).getUTCDay()).toBe(5); // Friday
  });

  it("\"Pay bob.nad 20 USDC every Monday.\" → weekly on Mondays, same first run as the words", async () => {
    const text = "Pay bob.nad 20 USDC every Monday.";
    const u = await understand(text, [], null);
    expect(u).toMatchObject({ kind: "recurring_payment", outcome: "complete" });
    expect(slotsOf(u)).toMatchObject({ amount: "20", asset: "USDC", recipient: "bob.nad", frequency: "weekly" });
    const { parse } = engineReadingOf(u);
    expect(parse).toMatchObject({ cadence: "weekly", needsTime: false, nextRun: parseScheduleIntent(text)!.nextRun });
    expect(new Date(parse!.nextRun!).getUTCDay()).toBe(1);
  });

  it("\"Schedule a payment to bob.nad for tomorrow.\" → keeps tomorrow and asks only for the amount", async () => {
    const u = await understand("Schedule a payment to bob.nad for tomorrow.", [], null);
    expect(u).toMatchObject({ kind: "schedule_payment", outcome: "incomplete", question: "How much would you like to send?" });
    expect(slotsOf(u).recipient).toBe("bob.nad");
    expect(slotsOf(u).when).toBeTruthy();       // the date the person gave is kept
    expect(slotsOf(u).asset).toBeNull();        // no token was named — none is invented
    expect(slotsOf(u).frequency).toBeNull();
  });

  it("\"Send 10 USDC to bob.nad at 9 AM tomorrow.\" → asked about, never assumed to be UTC", async () => {
    // The engine runs every schedule at 09:00 UTC. "9 AM" with no timezone
    // only matches that for someone in UTC — for anyone else it would run at
    // the wrong local time. So the timezone is asked about, not assumed.
    const u = await understand("Send 10 USDC to bob.nad at 9 AM tomorrow.", [], null);
    expect(u).toMatchObject({ kind: "unsupported", capability: "schedule_timing" });
    expect((u as { reply: string }).reply).toMatch(/09:00 UTC/);
  });

  it("\"Send 10 USDC to bob.nad at 9 AM UTC tomorrow.\" → a complete one-time payment for tomorrow at 09:00 UTC", async () => {
    const text = "Send 10 USDC to bob.nad at 9 AM UTC tomorrow.";
    const u = await understand(text, [], null);
    expect(u).toMatchObject({ kind: "schedule_payment", outcome: "complete" });
    const { parse } = engineReadingOf(u);
    expect(parse).toMatchObject({ cadence: "once", needsTime: false, nextRun: parseScheduleIntent(text)!.nextRun });
  });

  it("\"Pay bob.nad every month.\" → keeps monthly; asks for the amount, and invents no token", async () => {
    const u = await understand("Pay bob.nad every month.", [], null);
    expect(u).toMatchObject({ kind: "recurring_payment", outcome: "incomplete", question: "How much would you like to send?" });
    expect(slotsOf(u)).toMatchObject({ recipient: "bob.nad", frequency: "monthly", asset: null, amount: null });
  });

  it("\"Send 20 USDC to bob.nad.\" → an ordinary send, with no schedule attached", async () => {
    const u = await understand("Send 20 USDC to bob.nad.", [], null);
    expect(u).toMatchObject({ kind: "send_payment", outcome: "complete" });
    expect(slotsOf(u)).toMatchObject({ when: null, frequency: null });
  });
});

describe("asking only for what's missing", () => {
  it("a weekly payment with no day asks which day — not a generic \"when\"", async () => {
    const u = await understand("Send 5 USDC to bob.nad every week", [], null);
    expect(u).toMatchObject({ kind: "recurring_payment", outcome: "incomplete", question: "Which day should it run each week?" });
  });

  it("answering that question with a day completes it, and the engine schedules that day", async () => {
    const first = await understand("Send 5 USDC to bob.nad every week", [], null);
    const second = await understand("Friday", [], first);
    expect(second).toMatchObject({ kind: "recurring_payment", outcome: "complete" });
    const { text, parse } = engineReadingOf(second);
    expect(text).toMatch(/every friday$/);
    expect(parse).toMatchObject({ cadence: "weekly", needsTime: false });
    expect(new Date(parse!.nextRun!).getUTCDay()).toBe(5);
  });

  it("daily and monthly cadences need no extra day", () => {
    const base: AskSlots = { amount: "1", asset: "USDC", recipient: "bob.nad", when: null, frequency: "daily", fromAsset: null, toAsset: null, recipientCount: null, txHash: null, tokenAddress: null, tradeAction: null, amountType: null, slippage: null } as AskSlots;
    expect(missingSlots("recurring_payment", base)).toEqual([]);
    expect(missingSlots("recurring_payment", { ...base, frequency: "monthly" })).toEqual([]);
    expect(missingSlots("recurring_payment", { ...base, frequency: "weekly" })).toEqual(["when"]);
  });
});

describe("the model can't silently discard a parsed schedule", () => {
  const det = (text: string) => understand(text, [], null);

  it("a model reading of \"every Friday\" as an immediate send is corrected back to the weekly schedule", async () => {
    const d = await det("Send 1 USDC to bob.nad every Friday.");
    const model: Understanding = { kind: "send_payment", outcome: "complete", slots: { ...slotsOf(d), when: null, frequency: null } };
    const r = reconcileSchedule(model, d);
    expect(r).toMatchObject({ kind: "recurring_payment", outcome: "complete" });
    expect(slotsOf(r)).toMatchObject({ frequency: "weekly", when: slotsOf(d).when });
  });

  it("a model that dropped the day or the cadence gets them back from the deterministic parse", async () => {
    const d = await det("Pay bob.nad 20 USDC every Monday.");
    const model: Understanding = { kind: "recurring_payment", outcome: "incomplete", question: "When should it run?", slots: { ...slotsOf(d), when: null, frequency: null } };
    const r = reconcileSchedule(model, d);
    expect(r).toMatchObject({ kind: "recurring_payment", outcome: "complete" });
    expect(slotsOf(r)).toMatchObject({ frequency: "weekly", when: slotsOf(d).when });
  });

  it("a conflicting model day loses to the parsed day", async () => {
    const d = await det("Send 1 USDC to bob.nad every Friday.");
    const model: Understanding = { kind: "recurring_payment", outcome: "complete", slots: { ...slotsOf(d), when: "Monday" } };
    expect(slotsOf(reconcileSchedule(model, d)).when).toBe(slotsOf(d).when);
  });

  it("the model still fills what the parser couldn't (e.g. the token), and is untouched when there's no schedule", async () => {
    const d = await det("Pay bob.nad every month.");
    const model: Understanding = { kind: "recurring_payment", outcome: "incomplete", question: "How much?", slots: { ...slotsOf(d), asset: "USDC", amount: "15" } };
    expect(reconcileSchedule(model, d)).toMatchObject({ kind: "recurring_payment", outcome: "complete" });

    const plain = await det("Send 20 USDC to bob.nad.");
    const sameModel: Understanding = { kind: "send_payment", outcome: "complete", slots: slotsOf(plain) };
    expect(reconcileSchedule(sameModel, plain)).toBe(sameModel);
  });
});

describe("scheduleRequestText", () => {
  const s = (over: Partial<AskSlots>) => ({ amount: "1", asset: "USDC", recipient: "bob.nad", when: null, frequency: null, ...over }) as AskSlots;

  it("never writes \"every weekly\" (or any every-<frequency> phrase the engine can't read)", () => {
    for (const f of ["daily", "weekly", "monthly"] as const) {
      expect(scheduleRequestText("recurring_payment", s({ frequency: f, when: "Friday" }))).not.toMatch(/every (daily|weekly|monthly)/);
    }
  });

  it("keeps an exact start date, a weekday or a relative phrase — and adds nothing else", () => {
    expect(scheduleRequestText("recurring_payment", s({ frequency: "weekly", when: "2026-10-16T09:00:00.000Z" }))).toBe("Schedule 1 USDC to bob.nad every week on 2026-10-16");
    expect(scheduleRequestText("recurring_payment", s({ frequency: "monthly", when: null }))).toBe("Schedule 1 USDC to bob.nad every month");
    expect(scheduleRequestText("schedule_payment", s({ when: "tomorrow" }))).toBe("Schedule 1 USDC to bob.nad tomorrow");
    expect(scheduleRequestText("schedule_payment", s({ when: "Friday" }))).toBe("Schedule 1 USDC to bob.nad on friday");
  });

  it("passes an unreadable time through unchanged, so the engine asks instead of defaulting", () => {
    const text = scheduleRequestText("schedule_payment", s({ when: "sometime soon" }));
    expect(text).toBe("Schedule 1 USDC to bob.nad on sometime soon");
    expect(parseScheduleIntent(text)).toMatchObject({ needsTime: true, nextRun: null });
  });
});
