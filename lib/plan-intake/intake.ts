/**
 * Plan intake from text (Phase 2C, Stage 5B): the server-side bridge between
 * the deterministic Intent Adapter (Stage 5A) and the Plan Service.
 *
 *   createPlanFromText(auth, text)
 *     → fresh server intentId + the authenticated wallet + the server's chain
 *     → draftIntentGraph(text)          (deterministic; refuses anything else)
 *     → service.createPlan(auth, draft) (validate, plan, pin recipients, store)
 *     → { plan, review }                (both server-derived from the stored plan)
 *
 * Trusted identity comes only from here: the wallet from `auth` (the wallet
 * grant, verified by the route), the chain from server configuration, and a
 * cryptographically random intentId per request — so two identical requests
 * are two separate plans. Nothing in the request body, query or text can set
 * any of them. The text is passed to the adapter exactly as received (no
 * sanitizing or rewriting): source.text is what the adapter parsed.
 *
 * Creates a plan; never approves, quotes, builds, signs, sends or settles it.
 *
 * Server-only.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { adapterError, type AdapterError } from "@/lib/plan-adapter/grammar";
import type { PlanReview } from "@/lib/plan/review";
import type { PlanAuth, PlanView } from "@/lib/plan/service";

/** A fresh request id: "intent_" + 24 random hex characters (fits the
 *  IntentGraph id rule ^[A-Za-z0-9_-]{8,64}$). */
export function newIntentId(): string {
  return `intent_${randomBytes(12).toString("hex")}`;
}

export async function createPlanFromText(
  auth: PlanAuth, text: unknown,
): Promise<{ ok: true; plan: PlanView; review: PlanReview } | AdapterError> {
  if (typeof text !== "string") return adapterError("UNSUPPORTED_REQUEST");
  const { getChain } = await import("@/lib/monad/config");
  const { draftIntentGraph } = await import("@/lib/plan-adapter/adapter");
  const drafted = draftIntentGraph(text, { intentId: newIntentId(), wallet: auth.wallet, chainId: getChain().id });
  if (!drafted.ok) return drafted;

  const service = await import("@/lib/plan/service");
  const created = await service.createPlan(auth, drafted.draft);
  return { ok: true, ...(await service.getPlanWithReview(auth, created.planId)) };
}
