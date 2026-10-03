/**
 * The canonical SDK quote sequence — the ONE place a quote token is issued
 * for an action:
 *
 *   validateForQuote → action.quote → enforcePaymentPolicy → issueQuoteToken
 *
 * Extracted unchanged from POST /api/ask/action (which now calls it), so the
 * preview route and the Plan Service (lib/plan/service.ts) quote through
 * exactly the same validation, policy and token binding — never a second
 * path. Read-only: it never builds, signs, broadcasts or touches a wallet,
 * and it knows nothing about plans, sessions or HTTP.
 *
 * Errors an action throws from quote()/outflows() (ActionInputError for the
 * user's input, anything else for internal failures) propagate to the
 * caller, exactly as they did inside the route.
 *
 * Server-only.
 */
import "server-only";
import type { PolicyResult } from "./policy";
import type { Action, ActionInputs, ActionQuoteResult, ProtocolAdapter } from "./types";

export interface QuoteActionIdentity {
  protocolId: string;
  actionId: string;
  version: string;
}

export type QuoteActionResult =
  | {
      ok: true;
      action: Action;
      protocol: ProtocolAdapter;
      /** The validated inputs the quote — and its token — are bound to. */
      inputs: ActionInputs;
      quote: ActionQuoteResult;
      /** Null when the action declares no outflows. */
      policy: PolicyResult | null;
      quoteToken: string;
      quoteId: string;
    }
  | {
      ok: false;
      /** A validation code (lib/sdk/validate.ts) or "POLICY_BLOCKED". */
      code: string;
      message: string;
    };

export async function quoteAction(id: QuoteActionIdentity, rawInputs: ActionInputs): Promise<QuoteActionResult> {
  const { ensureBuiltinsRegistered } = await import("./bootstrap");
  const { validateForQuote } = await import("./validate");
  const { getChain } = await import("@/lib/monad/config");
  const { enforcePaymentPolicy } = await import("./policy");
  const { issueQuoteToken } = await import("./quoteToken");
  ensureBuiltinsRegistered();

  const chainId = getChain().id;
  const request = {
    protocolId: id.protocolId, actionId: id.actionId, version: id.version,
    inputs: rawInputs,
    // walletAddress isn't needed to PREVIEW (quote() takes only inputs), but
    // ExecutionRequest requires the field — a preview is chain-pinned and
    // freshly timestamped here, and re-validated with a real wallet at build.
    walletAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    chainId, quotedAt: Date.now(),
  };

  const gated = validateForQuote(request, chainId);
  if (!gated.ok) return { ok: false, code: gated.code, message: gated.message };

  const { action, protocol, inputs } = gated.value;
  const quote = await action.quote(inputs);

  const policy = action.outflows ? await enforcePaymentPolicy(await action.outflows(inputs)) : null;
  if (policy && !policy.allowed) {
    return { ok: false, code: "POLICY_BLOCKED", message: policy.reason ?? "This payment can't be made." };
  }

  const { quoteToken, quoteId } = issueQuoteToken(
    { protocolId: action.protocolId, actionId: action.actionId, version: action.version, chainId: action.chainId },
    inputs, quote.quotedAt, quote.terms, quote.snapshot,
  );
  return { ok: true, action, protocol, inputs, quote, policy, quoteToken, quoteId };
}
