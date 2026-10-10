/**
 * What the schedule engine (parseScheduleIntent in ./brain.ts) can and can't
 * read about WHEN a payment should run — so a request never gets a time it
 * didn't ask for, and a timing phrase is never silently dropped.
 *
 * The engine's model, stated plainly:
 *   - Date:        tomorrow · next week · next month · in N days/weeks/months ·
 *                  on YYYY-MM-DD · on/this/next <weekday> (the coming one) ·
 *                  every <weekday>
 *   - Recurrence:  daily / every day · weekly / every week / every <weekday> ·
 *                  monthly / every month
 *   - Time of day: NOT read. Every run is at 09:00 UTC on its day; a request
 *                  that says exactly that ("at 9 AM UTC") is accepted.
 *   - Timezone:    NOT read. Runs are scheduled in UTC; a time without a
 *                  timezone is not assumed to be UTC.
 *
 * Before this guard, anything outside that model was ignored: "tomorrow at
 * 3pm" ran at 09:00 UTC, "9am EST" ran at 09:00 UTC, and phrases the engine
 * doesn't recognise as a schedule at all — "tonight", "every 2 weeks", "on
 * October 20", "next friday at noon", "in 2 hours" — fell through to an
 * IMMEDIATE send. unreadableTiming() names the first such phrase so the
 * request is clarified before anything is prepared.
 *
 * Pure: no clock, no I/O.
 */

/** The fixed time every scheduled run uses — shown at review, never hidden. */
export const SCHEDULE_RUN_TIME_UTC = "09:00 UTC";

export const SCHEDULE_TIMING_HELP =
  `Scheduled payments run at ${SCHEDULE_RUN_TIME_UTC} on the day you choose. PayAI can read "tomorrow", "in 3 days", ` +
  `"on 2026-07-01", "on Friday", "every Friday", "every day", "every week" and "every month" — not another time of day, ` +
  `another timezone, or dates like "the 5th", "October 20" or "every 2 weeks" yet. To pick an exact date and time ` +
  `in your own timezone, set it up in Payment Automations.`;

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** [what the phrase is, pattern] — checked in order; the first match is reported. */
const UNREADABLE: [string, RegExp][] = [
  ["a time of day", /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b(?:at|by|@)\s*\d{1,2}(?::\d{2})?\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midday|midnight|tonight)\b|\b(?:this|in\s+the|every|tomorrow)\s+(?:morning|afternoon|evening|night)\b/i],
  ["a timezone", /\b(?:utc|gmt)\s*[+-]\s*\d{1,2}\b|\b(?:utc|gmt|est|edt|cst|cdt|mst|mdt|pst|pdt|cet|cest|bst|wat|eat|ist|jst|sgt|aest|aedt|wib|hkt)\b/i],
  ["a time in hours or minutes", /\bin\s+(?:\d+|an?|a\s+few|few|half\s+an?)\s+(?:hours?|hrs?|minutes?|mins?)\b/i],
  ["an interval PayAI can't schedule", /\bevery\s+(?:other|\d+|second|third|two|three|four|few|couple)(?:\s+(?:of\s+)?[a-z]+)?\b|\b(?:fortnight(?:ly)?|bi-?weekly|bi-?monthly|quarterly|yearly|annually|every\s+year|every\s+weekday|every\s+weekend|weekdays|weekends)\b/i],
  ["a date PayAI can't read", new RegExp(String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}\b|\b\d{1,2}(?:st|nd|rd|th)\b|\bthe\s+(?:first|last|end)(?:\s+of\s+(?:the\s+)?(?:week|month|year))?\b|\bend\s+of\s+(?:the\s+)?(?:week|month|year)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b`, "i")],
  ["a time PayAI can't read", /\b(?:later(?:\s+today)?|soon|eventually|this\s+week(?:end)?|this\s+month)\b/i],
];

/**
 * The first timing phrase the engine can't honour, as `{ kind, phrase }`, or
 * null when every timing word in the request is one the engine reads. Only
 * meaningful for a money-moving request — callers check that first.
 */
/** Words that make a request about WHEN, not just about what it's for. */
const SCHEDULING_SIGNAL_RE = /\b(schedul\w*|automat\w*|recurring|every|each|daily|weekly|monthly|tomorrow|tonight|today|later|soon|next|this\s+(?:morning|afternoon|evening|week|weekend|month)|in\s+(?:\d+|an?|a\s+few|few|half)\s+\w+|(?:on|by|until)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|\b\d{4}-\d{2}-\d{2}\b/i;

/**
 * "…for lunch at 1pm", "…for the meeting at 3pm": a time inside the
 * payment's PURPOSE ("for <a few words> at <time>"), in a request that says
 * nothing else about when. That's a memo, not a schedule — it used to be
 * refused as an unreadable schedule. A request with any other timing word
 * keeps the strict reading (the time might be the schedule).
 */
function stripMemoTimes(t: string): string {
  if (SCHEDULING_SIGNAL_RE.test(t)) return t;
  return t.replace(/\bfor\s+((?:the|our|my|a|an|team|your)\s+)?[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3}\s+(?:at|@)\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?(?![\w:])/gi, " ");
}

export function unreadableTiming(text: string): { kind: string; phrase: string } | null {
  if (typeof text !== "string") return null;
  text = stripMemoTimes(text);
  // ISO dates ("2026-10-20") are read by the engine; keep them from looking
  // like anything else below.
  const t = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    // The engine's own run time, stated in UTC, IS what it does — "at 9 AM
    // UTC", "09:00 UTC". Without "UTC" a time's timezone isn't established,
    // so a bare "9 AM" is still asked about.
    .replace(/\b(?:at\s+)?(?:0?9(?::00)?\s*a\.?m\.?|09:00)\s*(?:utc|gmt)\b(?!\s*[+-]\s*\d)/gi, " ")
    // "UTC"/"GMT" alone (no offset) only restates the engine's timezone.
    .replace(/\b(?:utc|gmt)\b(?!\s*[+-]\s*\d)/gi, " ");
  for (const [kind, re] of UNREADABLE) {
    const m = t.match(re);
    if (m) return { kind, phrase: m[0].trim() };
  }
  return null;
}

/** The reply for a request whose timing can't be honoured. Nothing is prepared. */
export function unreadableTimingReply(found: { kind: string; phrase: string }): string {
  return `I can't schedule "${found.phrase}" — that's ${found.kind}. ${SCHEDULE_TIMING_HELP} Nothing was prepared.`;
}
