/**
 * One Ask PayAI turn's plan creation, through the Plan API's deterministic
 * text intake (POST /api/plans {text}) — never a second execution path:
 * creating a plan executes nothing; running it is runPlanInApp's job.
 *
 * Retry safety. A retried turn must never leave two live plans for one
 * request. An aborted fetch doesn't stop the server, so the first attempt
 * may still have created a plan. So a retry:
 *   1. first looks for an unapproved, uncancelled plan with the same request
 *      created during this turn, and reuses it if there is one;
 *   2. only otherwise creates one, and then cancels (abandons) any OTHER
 *      unapproved plan with the same request from this turn. Abandoning an
 *      unapproved plan is always safe: it was never approved, so nothing of
 *      it can have been quoted or sent.
 *
 * Returns null whenever the plan path can't serve the request (the adapter
 * refused it, no wallet grant, the server is unavailable, or the turn was
 * aborted) — the caller then falls back to the normal understanding path.
 */
import {
  abandonPlan, createPlanFromText, getPlanWithReview, listPlans, replyError,
  type ApiFetch, type PlanReviewDTO, type PlanSummaryDTO,
} from "@/lib/plans-client/api";
import type { PlanViewDTO } from "@/lib/plans-client/runner";
import type { PlanCardData } from "./planCards";

export interface PlanTurnOptions {
  /** Aborts this attempt's requests. */
  signal?: AbortSignal;
  /** When the turn started (ms since epoch) — the window for reuse/cleanup. */
  since: number;
  /** True on a retry: look for this turn's plan before creating one. */
  retry: boolean;
  /** For tests; defaults to the browser's fetch. */
  fetch?: ApiFetch;
}

export interface PlanTurnResult {
  data: PlanCardData | null;
  /** The server's reason when it refused the request (422/400), else null. */
  refusal?: { code: string | null; message: string } | null;
  /** The HTTP status of the create (0 when none arrived), for the caller's
   *  fallback decisions. 200 also when an existing plan was reused. */
  status: number;
}

/** Allowance for clock skew between this browser and the server. */
const SKEW_MS = 120_000;

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function withSignal(f: ApiFetch | undefined, signal: AbortSignal | undefined): ApiFetch | undefined {
  if (!signal) return f;
  const base: ApiFetch = f ?? ((url, init) => globalThis.fetch(url, init));
  return (url, init) => base(url, { ...init, signal });
}

function cardData(body: unknown): PlanCardData | null {
  const b = body as { ok?: unknown; plan?: PlanViewDTO; review?: PlanReviewDTO } | null;
  return b && b.ok === true && b.plan && b.review && typeof b.plan.planId === "string" ? { plan: b.plan, review: b.review } : null;
}

/** This turn's still-open plans for `text`: same request, not approved, not
 *  cancelled, nothing in flight, created within the turn's window. */
function sameTurnPlans(list: unknown, text: string, since: number): PlanSummaryDTO[] {
  if (!Array.isArray(list)) return [];
  const want = norm(text);
  return (list as PlanSummaryDTO[]).filter((p) =>
    p && typeof p.planId === "string" && typeof p.request === "string" && norm(p.request) === want
    && p.state === "planned" && p.abandoned === false && p.inFlight === false
    && typeof p.createdAt === "number" && p.createdAt >= since - SKEW_MS);
}

export async function createPlanForTurn(text: string, opts: PlanTurnOptions): Promise<PlanTurnResult> {
  const f = withSignal(opts.fetch, opts.signal);

  if (opts.retry) {
    const listed = await listPlans(f);
    if (opts.signal?.aborted) return { data: null, status: 0 };
    const existing = listed.status === 200 ? sameTurnPlans((listed.body as { plans?: unknown } | null)?.plans, text, opts.since) : [];
    if (existing.length > 0) {
      // Newest first from the API; keep the newest, cancel the rest.
      const [keep, ...extra] = existing;
      const got = await getPlanWithReview(keep.planId, f);
      const data = got.status === 200 ? cardData(got.body) : null;
      if (data) {
        await Promise.all(extra.map((p) => abandonPlan(p.planId, opts.fetch)));
        return { data, status: 200 };
      }
    }
  }

  const r = await createPlanFromText(text, f);
  if (opts.signal?.aborted) return { data: null, status: 0 };
  const data = r.status === 200 ? cardData(r.body) : null;
  // 422: the grammar refused the request; 400: the server refused part of it
  // (e.g. a recipient it couldn't resolve) — either way the reason is shown.
  const refusal = r.status === 422 || r.status === 400 ? replyError(r) : null;
  if (data && opts.retry) {
    // An earlier, aborted attempt may have created a plan after all.
    const listed = await listPlans(opts.fetch);
    if (listed.status === 200) {
      const extra = sameTurnPlans((listed.body as { plans?: unknown } | null)?.plans, text, opts.since)
        .filter((p) => p.planId !== data.plan.planId);
      await Promise.all(extra.map((p) => abandonPlan(p.planId, opts.fetch)));
    }
  }
  return { data, status: r.status, refusal };
}
