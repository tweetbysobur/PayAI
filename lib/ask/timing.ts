/**
 * Client-side latency marks for Ask PayAI turns.
 *
 *   const t = startAskTiming("plan");
 *   t.mark("intent_detected"); t.mark("plan_created");
 *   t.mark("response_rendered"); t.mark("quote_ready");
 *
 * Each mark is a `performance.mark` (so it appears in the browser's
 * Performance panel in production too) and is kept, with the turn's
 * elapsed milliseconds, in a small ring buffer at window.__payaiAskTimings.
 * In development each turn is also logged to the console. Nothing is sent
 * anywhere; server-side timings come from the routes' Server-Timing header
 * and log line (lib/platform/timing.ts). Never records message text.
 */

export type AskTimingMark = "request_received" | "intent_detected" | "plan_created" | "response_rendered" | "quote_ready" | "fallback";

export interface AskTiming {
  mark(name: AskTimingMark): void;
  /** Milliseconds since the turn started. */
  elapsed(): number;
}

interface Entry { path: string; marks: Partial<Record<AskTimingMark, number>> }

const MAX_ENTRIES = 50;
let seq = 0;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function startAskTiming(path: "plan" | "understand"): AskTiming {
  const id = `ask-${++seq}`;
  const start = now();
  const entry: Entry = { path, marks: { request_received: 0 } };
  try {
    const w = globalThis as { __payaiAskTimings?: Entry[] };
    const list = (w.__payaiAskTimings ??= []);
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  } catch { /* no window */ }
  return {
    mark(name) {
      if (entry.marks[name] !== undefined && name !== "quote_ready") return;
      const ms = Math.round(now() - start);
      entry.marks[name] = ms;
      try { performance.mark(`${id}:${name}`); } catch { /* no performance API */ }
      if (process.env.NODE_ENV !== "production") console.info(`[ask timing] ${path} ${name} +${ms}ms`);
    },
    elapsed: () => now() - start,
  };
}
