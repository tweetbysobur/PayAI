/**
 * The request text Ask PayAI hands to the existing schedule engine
 * (POST /api/agent → parseScheduleIntent in lib/agent/brain.ts) for a
 * scheduled or recurring payment it has understood.
 *
 * It must carry the schedule the person actually gave. It used to be built as
 * "Schedule 1 USDC to name.nad every weekly" — which dropped the day ("every
 * Friday") and which the engine can't read at all ("every weekly" is not a
 * phrase it knows), so a fully specified request came back as "When should
 * it run?". This writes only phrases the engine's own grammar understands,
 * and only from what was understood — it never adds a day, date or time the
 * person didn't give. A schedule it can't express is passed through as-is so
 * the engine asks about it honestly, rather than being replaced by a default.
 *
 * Pure: no I/O, so it is unit-tested directly (test/ask-schedule-intent.test.ts).
 */
import type { AskSlots } from "./types";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?$/;
/** Relative phrases the engine's parseScheduleIntent resolves on its own. */
const ENGINE_PHRASE = /^(tomorrow|next (?:week|month)|in \d+ (?:day|week|month)s?)$/;

type ScheduleSlots = Pick<AskSlots, "amount" | "asset" | "recipient" | "when" | "frequency">;

/** "2026-10-16" for an ISO date/datetime, the weekday for a weekday name,
 *  the phrase for a relative phrase the engine knows — else null. */
function anchorOf(when: string | null | undefined): { date: string } | { weekday: string } | { phrase: string } | null {
  const w = when?.trim();
  if (!w) return null;
  const iso = w.match(ISO_DATE);
  if (iso) return { date: iso[1] };
  const lower = w.toLowerCase().replace(/^(on|every|this|next)\s+(?=(sun|mon|tues|wednes|thurs|fri|satur)day\b)/, "").replace(/[.!]+$/, "");
  const weekday = WEEKDAYS.find((d) => lower === d || lower === `${d}s`);
  if (weekday) return { weekday };
  if (ENGINE_PHRASE.test(lower)) return { phrase: lower };
  return null;
}

export function scheduleRequestText(kind: "schedule_payment" | "recurring_payment", slots: ScheduleSlots): string {
  const head = `Schedule ${slots.amount} ${slots.asset} to ${slots.recipient}`;
  const anchor = anchorOf(slots.when);

  if (kind === "recurring_payment") {
    const unit = slots.frequency === "daily" ? "day" : slots.frequency === "monthly" ? "month" : "week";
    if (anchor && "weekday" in anchor && slots.frequency === "weekly") return `${head} every ${anchor.weekday}`;
    if (anchor && "date" in anchor) return `${head} every ${unit} on ${anchor.date}`;
    if (anchor && "phrase" in anchor) return `${head} every ${unit} ${anchor.phrase}`;
    if (anchor && "weekday" in anchor) return `${head} every ${unit} ${anchor.weekday}`;
    // No start given: the engine applies its own documented default for a
    // daily/monthly cadence; a weekly one without a day is asked about
    // upstream (missingSlots) before it ever reaches here.
    return `${head} every ${unit}`;
  }

  if (anchor && "date" in anchor) return `${head} on ${anchor.date}`;
  if (anchor && "weekday" in anchor) return `${head} on ${anchor.weekday}`;
  if (anchor && "phrase" in anchor) return `${head} ${anchor.phrase}`;
  // Not a phrase the engine knows — pass it through unchanged so the engine
  // asks for a usable time instead of a default being substituted.
  return `${head} on ${slots.when ?? ""}`.trim();
}
