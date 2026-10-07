/**
 * The Plan API calls the app makes OUTSIDE execution: create a plan from a
 * request, list the wallet's plans, read one with its server-derived review,
 * and approve it. Approval executes nothing.
 *
 * Deliberately absent: next, quote, bind, tx, intent, release, settle and the
 * SDK build / confirm routes. Those belong to the Plan Runner alone, reached
 * through runPlanInApp (./app.ts). The wallet grant is the browser's HttpOnly
 * cookie; nothing here sees it. Browser-safe: no imports.
 */

/* ── The plan review, as the API returns it (local mirrors of lib/plan/review
 *    — a server module the browser must not import). Only what the screen
 *    shows; the server derives all of it from the stored plan. ── */

export interface ReviewAmountDTO {
  kind: "exact";
  units: string;
  decimal: string;
  symbol: string;
}

export interface ReviewOutputAmountDTO {
  kind: "output";
  fromStep: string;
  output: string;
  symbol: string;
  known: false;
}

interface ReviewStepBaseDTO {
  nodeId: string;
  order: number;
}

export type ReviewStepDTO =
  | (ReviewStepBaseDTO & {
      action: "swap";
      pay: ReviewAmountDTO | ReviewOutputAmountDTO;
      receiveToken: { symbol: string; address: string | null };
      slippageBps: number;
    })
  | (ReviewStepBaseDTO & {
      action: "transfer";
      amount: ReviewAmountDTO | ReviewOutputAmountDTO;
      recipient: { display: string; source: "address" | "nad" | "payee"; address: string };
    })
  | (ReviewStepBaseDTO & { action: "unsupported" });

export interface PlanReviewDTO {
  planId: string;
  /** The user's original request — inert text. */
  request: string;
  steps: ReviewStepDTO[];
  /** True only when every step is one the review describes faithfully. */
  reviewable: boolean;
}

export interface ApiReply {
  /** 0 when no response arrived. */
  status: number;
  body: unknown;
}

export type ApiFetch = (url: string, init: RequestInit) => Promise<{ status: number; text(): Promise<string> }>;

async function send(fetchImpl: ApiFetch | undefined, method: "GET" | "POST", path: string, body?: unknown): Promise<ApiReply> {
  const f: ApiFetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  let res: { status: number; text(): Promise<string> };
  try {
    res = await f(path, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { status: 0, body: null };
  }
  let parsed: unknown = null;
  try {
    const text = await res.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

const planPath = (planId: string) => `/api/plans/${encodeURIComponent(planId)}`;

/** POST /api/plans {text} — the deterministic text intake (422 when refused). */
export const createPlanFromText = (text: string, f?: ApiFetch) => send(f, "POST", "/api/plans", { text });
/** GET /api/plans — this wallet's plans, newest first. */
export const listPlans = (f?: ApiFetch) => send(f, "GET", "/api/plans");
/** GET /api/plans/:id — the plan and its review, both derived on the server. */
export const getPlanWithReview = (planId: string, f?: ApiFetch) => send(f, "GET", planPath(planId));
/** POST /api/plans/:id {op:"approve"} — refused unless every step is reviewable. */
export const approvePlan = (planId: string, f?: ApiFetch) => send(f, "POST", planPath(planId), { op: "approve" });

/** The server's error code and message from a refused reply, when given. */
export function replyError(r: ApiReply): { code: string | null; message: string } {
  const b = r.body as { code?: unknown; message?: unknown; error?: unknown } | null;
  const code = b && typeof b.code === "string" ? b.code : null;
  const message = b && typeof b.message === "string" ? b.message
    : b && typeof b.error === "string" ? b.error
    : r.status === 0 ? "Couldn't reach PayAI. Check your connection."
    : r.status === 401 ? "Unlock your wallet to manage your plans."
    : "Something went wrong. Try again in a moment.";
  return { code, message };
}
