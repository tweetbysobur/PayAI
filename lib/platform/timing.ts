/**
 * Lightweight request timing for latency-critical routes (Ask PayAI).
 *
 *   const t = createTiming("plans.create");
 *   t.mark("auth"); … t.mark("plan");
 *   return t.finish(response);
 *
 * finish() adds a standard `Server-Timing` header (visible in the browser's
 * Network panel, dev and production alike) and writes ONE structured log
 * line, which Vercel's runtime logs keep — so production latency can be read
 * without a new endpoint or vendor. Phase names and durations only: never a
 * request body, wallet, address or token.
 */

export interface Timing {
  /** Records the time since the previous mark (or the start) under `name`. */
  mark(name: string): void;
  /** Attaches the timings to `res` and logs them. Returns `res`. */
  finish<R extends { headers: Headers; status: number }>(res: R, extra?: Record<string, string | number | boolean>): R;
}

const PHASE_RE = /^[a-z][a-z0-9_.-]{0,31}$/;

export function createTiming(route: string, now: () => number = () => performance.now()): Timing {
  const start = now();
  let last = start;
  const phases: [string, number][] = [];
  return {
    mark(name) {
      if (!PHASE_RE.test(name)) return;
      const t = now();
      phases.push([name, t - last]);
      last = t;
    },
    finish(res, extra) {
      const total = now() - start;
      const header = [...phases.map(([n, d]) => `${n};dur=${d.toFixed(1)}`), `total;dur=${total.toFixed(1)}`].join(", ");
      try {
        res.headers.set("Server-Timing", header);
      } catch { /* immutable headers: the log line still records it */ }
      const line: Record<string, unknown> = { evt: "timing", route, status: res.status, totalMs: Math.round(total) };
      for (const [n, d] of phases) line[`${n}Ms`] = Math.round(d);
      if (extra) for (const [k, v] of Object.entries(extra)) if (/^[a-zA-Z]{1,24}$/.test(k)) line[k] = v;
      console.info(JSON.stringify(line));
      return res;
    },
  };
}
