import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { unreadableTiming, SCHEDULE_RUN_TIME_UTC } from "@/lib/agent/scheduleTiming";
import { parseScheduleIntent } from "@/lib/agent/brain";
import { understand } from "@/lib/ask/intent/classify";
import { advanceRun, advanceRunPast, monthlyAnchorDay } from "@/lib/platform/schedules";
import { localDateInput, localTimeInput } from "@/components/dashboard/AutomationCreator";
import { fmtRunTime } from "@/components/ask/OperationCard";

/**
 * Scheduling correctness. A schedule is something the user authorises now for
 * money that moves later, so what PayAI understood about WHEN must be exactly
 * what it does — or it must say what it can't do, before anything is prepared.
 *
 * The engine (parseScheduleIntent) reads a date, a recurrence and a weekday.
 * It does not read a time of day or a timezone: every run is 09:00 UTC. These
 * tests pin the four things a schedule can carry separately — date,
 * recurrence, time, timezone — and the failures found in the audit:
 *   - "tomorrow at 3pm" ran at 09:00 UTC; "9am EST" ran at 09:00 UTC;
 *   - "tonight", "every 2 weeks", "on October 20", "next friday at noon",
 *     "in 2 hours", "on Friday" became an IMMEDIATE send;
 *   - "on the 1st of every month" started a month from today;
 *   - weekly runs drifted an hour across daylight-saving changes;
 *   - the automation creator's prefill put the first run a day off west of UTC−9.
 */

beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("unreadableTiming — what the engine can't honour is named, never dropped", () => {
  const UNREADABLE: [string, RegExp][] = [
    ["Send 1 USDC to bob.nad tomorrow at 3pm", /3pm/],
    ["Send 1 USDC to bob.nad every Friday 9am EST", /9am/],
    ["Send 1 USDC to bob.nad on 2026-10-20 at 14:00 UTC", /14:00/],
    ["Send 1 USDC to bob.nad tonight", /tonight/],
    ["Send 1 USDC to bob.nad tomorrow morning", /tomorrow morning/],
    ["Send 1 USDC to bob.nad every 2 weeks", /every 2 weeks/],
    ["Send 1 USDC to bob.nad every other friday", /every other friday/],
    ["Send 1 USDC to bob.nad every weekday", /every weekday/],
    ["Send 1 USDC to bob.nad on the 1st of every month", /1st/],
    ["Send 1 USDC to bob.nad at the end of the month", /the end of the month/],
    ["Send 1 USDC to bob.nad on October 20", /October 20/],
    ["Send 1 USDC to bob.nad on 20/10", /20\/10/],
    ["Send 1 USDC to bob.nad in 2 hours", /in 2 hours/],
    ["Send 1 USDC to bob.nad later", /later/],
    ["Send 1 USDC to bob.nad tomorrow GMT+1", /GMT\+1/],
    ["Send 1 USDC to bob.nad at 9 AM tomorrow", /at 9/],
  ];
  for (const [text, phrase] of UNREADABLE) {
    it(`"${text}" → names ${phrase}`, () => {
      const found = unreadableTiming(text);
      expect(found, text).not.toBeNull();
      expect(found!.phrase).toMatch(phrase);
    });
  }

  const READABLE = [
    "Send 1 USDC to bob.nad every Friday",
    "Send 1 USDC to bob.nad every month",
    "Send 1 USDC to bob.nad every day",
    "Send 1 USDC to bob.nad tomorrow",
    "Send 1 USDC to bob.nad in 3 days",
    "Send 1 USDC to bob.nad on 2026-10-20",
    "Send 1 USDC to bob.nad on Friday",
    "Send 1 USDC to bob.nad next Friday",
    "Send 1 USDC to bob.nad at 9 AM UTC tomorrow",
    "Send 1 USDC to bob.nad tomorrow at 09:00 UTC",
    "Send 2.5 USDC to bob.nad",
    "Send 10 USDC to 0x1111111111111111111111111111111111111111",
    "Send 10 USDC to bob.nad today",
  ];
  for (const text of READABLE) {
    it(`"${text}" → nothing unreadable`, () => expect(unreadableTiming(text)).toBeNull());
  }
});

describe("Ask never prepares a payment whose timing it couldn't read", () => {
  const CASES = [
    "Send 1 USDC to bob.nad tomorrow at 3pm",
    "Send 1 USDC to bob.nad every 2 weeks",
    "Send 1 USDC to bob.nad tonight",
    "Send 1 USDC to bob.nad next friday at noon",
    "Send 1 USDC to bob.nad on October 20",
    "Send 1 USDC to bob.nad on the 1st of every month",
    "Send 1 USDC to bob.nad in 2 hours",
    "Send 1 USDC to bob.nad every Friday 9am EST",
  ];
  for (const text of CASES) {
    it(`"${text}" → clarified, with the run-time rule stated; no operation`, async () => {
      const u = await understand(text, [], null);
      expect(u).toMatchObject({ kind: "unsupported", outcome: "unsupported", capability: "schedule_timing" });
      const reply = (u as { reply: string }).reply;
      expect(reply).toContain(SCHEDULE_RUN_TIME_UTC);
      expect(reply).toMatch(/Nothing was prepared/);
      expect(reply).toMatch(/Payment Automations/); // where an exact time CAN be chosen
    });
  }

  it("a question about the past isn't mistaken for a schedule", async () => {
    const u = await understand("What did I pay bob.nad at 3pm?", [], null);
    expect(u.kind).not.toBe("unsupported");
  });

  it("supported timing still schedules — and \"on / next Friday\" is a one-time Friday run, never an immediate send", async () => {
    for (const [text, kind] of [
      ["Send 1 USDC to bob.nad every Friday", "recurring_payment"],
      ["Send 1 USDC to bob.nad on Friday", "schedule_payment"],
      ["Send 1 USDC to bob.nad next Friday", "schedule_payment"],
      ["Send 1 USDC to bob.nad at 9 AM UTC tomorrow", "schedule_payment"],
    ] as const) {
      const u = await understand(text, [], null);
      expect(u, text).toMatchObject({ kind, outcome: "complete" });
      const when = new Date((u as { slots: { when: string } }).slots.when);
      expect(when.getUTCHours(), text).toBe(9);
      if (/friday/i.test(text)) expect(when.getUTCDay(), text).toBe(5);
    }
  });

  it("the engine reads \"on Friday\" as a schedule (it used to return null → an immediate send)", () => {
    expect(parseScheduleIntent("Send 1 USDC to bob.nad on Friday")).toMatchObject({ cadence: "once", needsTime: false });
    expect(parseScheduleIntent("Send 1 USDC to bob.nad this Friday")).toMatchObject({ cadence: "once", needsTime: false });
  });
});

describe("/api/agent refuses unreadable timing too (defence in depth)", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL }; });
  const post = (body: unknown) => new NextRequest("http://localhost/api/agent", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  for (const intent of ["Schedule 1 USDC to bob.nad on 3pm", "Send 1 USDC to bob.nad tonight", "automate 10 USDC to bob.nad every 2 weeks"]) {
    it(`"${intent}" → 400 schedule_error; nothing built or saved`, async () => {
      const { POST } = await import("@/app/api/agent/route");
      const res = await POST(post({ intent, walletAddress: "0x2222222222222222222222222222222222222222", idempotencyKey: `t-${Math.random()}` }));
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.decision).toBe("schedule_error");
      expect(json.unsignedTx).toBeUndefined();
      expect(json.prefill).toBeUndefined();
    });
  }
});

describe("recurring runs keep their local time across daylight saving", () => {
  // 2026-03-08: US clocks spring forward. 2026-11-01: they fall back.
  const NY = "America/New_York";

  it("weekly at 09:00 New York stays 09:00 New York across the March change (13:00Z → 13:00Z is wrong)", () => {
    const before = Date.parse("2026-03-06T14:00:00Z"); // Fri 09:00 EST (UTC−5)
    const next = advanceRun(before, "weekly", undefined, NY)!;
    expect(new Date(next).toISOString()).toBe("2026-03-13T13:00:00.000Z"); // Fri 09:00 EDT (UTC−4)
  });

  it("…and across the November change", () => {
    const before = Date.parse("2026-10-30T13:00:00Z"); // Fri 09:00 EDT
    expect(new Date(advanceRun(before, "weekly", undefined, NY)!).toISOString()).toBe("2026-11-06T14:00:00.000Z"); // 09:00 EST
  });

  it("daily and monthly keep the wall-clock time too", () => {
    expect(new Date(advanceRun(Date.parse("2026-03-07T14:00:00Z"), "daily", undefined, NY)!).toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(new Date(advanceRun(Date.parse("2026-02-15T14:00:00Z"), "monthly", undefined, NY)!).toISOString()).toBe("2026-03-15T13:00:00.000Z");
  });

  it("a time that doesn't exist that day (02:30 on spring-forward) lands just after the gap, never a day off", () => {
    const before = Date.parse("2026-03-07T07:30:00Z"); // Sat 02:30 EST
    const next = new Date(advanceRun(before, "daily", undefined, NY)!);
    expect(next.toISOString().slice(0, 10)).toBe("2026-03-08");
  });

  it("a zone without DST, no zone, or an unknown zone: unchanged UTC arithmetic", () => {
    const at = Date.parse("2026-03-06T08:00:00Z");
    expect(advanceRun(at, "weekly", undefined, "Africa/Lagos")).toBe(at + 7 * 86_400_000);
    expect(advanceRun(at, "weekly")).toBe(at + 7 * 86_400_000);
    expect(advanceRun(at, "weekly", undefined, "Not/AZone")).toBe(at + 7 * 86_400_000);
  });

  it("catch-up after an outage skips missed runs and keeps the zone", () => {
    const from = Date.parse("2026-02-27T14:00:00Z"); // Fri 09:00 EST
    const { next, skipped } = advanceRunPast(from, "weekly", undefined, Date.parse("2026-03-16T00:00:00Z"), NY);
    expect(skipped).toBe(2);
    expect(new Date(next!).toISOString()).toBe("2026-03-20T13:00:00.000Z");
  });

  it("a one-time run never repeats", () => expect(advanceRun(Date.now(), "once", undefined, NY)).toBeNull());
});

describe("what the user reviews", () => {
  it("the run time is stated in UTC — the timezone it is actually scheduled in", () => {
    expect(fmtRunTime("2026-10-16T09:00:00.000Z")).toMatch(/^Fri, Oct 16, 2026 · 09:00 UTC/);
    expect(fmtRunTime("not a date")).toBe("—");
  });

  it("the automation creator's prefill uses ONE calendar for date and time (it used UTC for one and local for the other)", () => {
    const ms = Date.parse("2026-10-16T09:00:00Z");
    const back = new Date(`${localDateInput(ms)}T${localTimeInput(ms)}:00`).getTime();
    expect(back).toBe(ms); // round-trips in whatever timezone the test runs in
  });
});

describe("a time in the payment's purpose is a memo, not a schedule (the /api/agent false positive)", () => {
  const MEMO = [
    "Send 10 USDC to bob.nad for lunch at 1pm",
    "Pay 5 USDC to alice.nad for the team meeting at 3pm",
    "send 2 MON to 0x1111111111111111111111111111111111111111 for dinner at 8:30 pm",
  ];
  for (const text of MEMO) {
    it(`"${text}" → nothing unreadable; Ask reads an ordinary send`, async () => {
      expect(unreadableTiming(text)).toBeNull();
      expect((await understand(text, [], null)).kind).toBe("send_payment");
    });
  }

  const STILL_STRICT: [string, RegExp][] = [
    ["Send 10 USDC to bob.nad at 1pm", /1pm/],                         // no purpose — the time IS the when
    ["Send 10 USDC to bob.nad tomorrow for lunch at 1pm", /1pm/],     // a schedule word: the time may be the schedule
    ["Send 10 USDC to bob.nad for lunch at 1pm every Friday", /1pm/],
    ["Schedule 10 USDC to bob.nad for lunch at 1pm", /1pm/],
  ];
  for (const [text, phrase] of STILL_STRICT) {
    it(`"${text}" → still asked about`, () => expect(unreadableTiming(text)?.phrase).toMatch(phrase));
  }

  it("/api/agent no longer refuses the memo as a schedule", async () => {
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(new NextRequest("http://localhost/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "send 2 USDC to 0x1111111111111111111111111111111111111111 for lunch at 1pm", walletAddress: "0x2222222222222222222222222222222222222222", idempotencyKey: `t-${Math.random()}` }),
    }));
    const json = await res.json();
    expect(json.decision).not.toBe("schedule_error");
    expect(JSON.stringify(json)).not.toMatch(/can't schedule/);
  });
});

describe("monthly automations keep their day of the month", () => {
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const chain = (start: string, steps: number, anchor?: number, tz?: string, interval?: { count: number; unit: "months" }) => {
    const out = [start];
    let at = Date.parse(start);
    for (let i = 0; i < steps; i++) {
      at = advanceRun(at, interval ? "custom" : "monthly", interval, tz, anchor)!;
      out.push(iso(at)!);
    }
    return out.map((s) => s.slice(0, 16));
  };

  it("the 31st: the last day of a shorter month, then back to the 31st (it used to stay on the 28th forever)", () => {
    expect(chain("2026-01-31T09:00:00Z", 4, 31)).toEqual(["2026-01-31T09:00", "2026-02-28T09:00", "2026-03-31T09:00", "2026-04-30T09:00", "2026-05-31T09:00"]);
  });

  it("leap years: 29 February when it exists", () => {
    expect(chain("2028-01-31T09:00:00Z", 2, 31)).toEqual(["2028-01-31T09:00", "2028-02-29T09:00", "2028-03-31T09:00"]);
    expect(chain("2028-01-30T09:00:00Z", 2, 30)).toEqual(["2028-01-30T09:00", "2028-02-29T09:00", "2028-03-30T09:00"]);
  });

  it("days every month has are unaffected", () => {
    expect(chain("2026-01-15T09:00:00Z", 3, 15)).toEqual(["2026-01-15T09:00", "2026-02-15T09:00", "2026-03-15T09:00", "2026-04-15T09:00"]);
  });

  it("every 3 months on the 31st", () => {
    expect(chain("2026-08-31T09:00:00Z", 3, 31, undefined, { count: 3, unit: "months" })).toEqual(["2026-08-31T09:00", "2026-11-30T09:00", "2027-02-28T09:00", "2027-05-31T09:00"]);
  });

  it("in a timezone: the local day and the local time are both kept, across daylight saving", () => {
    // 09:00 New York on Jan 31 (EST) → Feb 28 (EST) → Mar 31 (EDT): 14:00Z, 14:00Z, 13:00Z.
    expect(chain("2026-01-31T14:00:00Z", 2, 31, "America/New_York")).toEqual(["2026-01-31T14:00", "2026-02-28T14:00", "2026-03-31T13:00"]);
  });

  it("the anchor is the run's day in the automation's timezone, and only for month-based cadences", () => {
    expect(monthlyAnchorDay(Date.parse("2026-02-01T03:00:00Z"), "monthly", undefined, "America/New_York")).toBe(31); // still Jan 31 there
    expect(monthlyAnchorDay(Date.parse("2026-02-01T03:00:00Z"), "monthly", undefined, null)).toBe(1);
    expect(monthlyAnchorDay(Date.now(), "custom", "months", "UTC")).toBeTypeOf("number");
    expect(monthlyAnchorDay(Date.now(), "weekly", undefined, "UTC")).toBeUndefined();
    expect(monthlyAnchorDay(Date.now(), "custom", "weeks", "UTC")).toBeUndefined();
  });

  it("automations from before the anchor existed keep their old behaviour (step from the current date)", () => {
    expect(chain("2026-01-31T09:00:00Z", 2)).toEqual(["2026-01-31T09:00", "2026-02-28T09:00", "2026-03-28T09:00"]);
  });

  it("a new automation records its anchor; editing its first run moves the anchor", async () => {
    const { createSchedule, updateSchedule } = await import("@/lib/platform/schedules");
    const row = await createSchedule("m_anchor", {
      amount: 1, token: "USDC", recipient: "0x1111111111111111111111111111111111111111", cadence: "monthly",
      nextRun: Date.parse("2026-01-31T09:00:00Z"), timezone: "UTC", sender: "0x2222222222222222222222222222222222222222",
    });
    expect(row.anchorDay).toBe(31);
    const edited = await updateSchedule("m_anchor", row.id, { nextRun: Date.parse("2026-02-15T09:00:00Z") });
    expect(edited?.anchorDay).toBe(15);
    const weekly = await createSchedule("m_anchor", { amount: 1, token: "USDC", recipient: "0x1111111111111111111111111111111111111111", cadence: "weekly", nextRun: Date.now() + 86_400_000 });
    expect(weekly.anchorDay).toBeUndefined();
  });
});
