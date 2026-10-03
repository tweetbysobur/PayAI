import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/ask/action — PREVIEW an SDK protocol action. Read-only: it
 * resolves the exact registered action, validates the inputs (Phase 1
 * Layer A), and calls the action's quote(). It never calls build(), never
 * signs, never broadcasts — building real steps is a separate, confirm-only
 * route (/api/ask/action/build), exactly as trade preview (/api/ask/trade)
 * is separate from trade build (/api/ask/trade/build).
 *
 * The client supplies only structured identity + inputs (protocolId,
 * actionId, version, inputs) — never a target, calldata, or amount to sign.
 * Everything executable is derived server-side from the reviewed registry.
 *
 * Unauthenticated on purpose, same posture as /api/ask/trade: a preview
 * moves no funds and needs no signer.
 *
 * Two additions sit between the quote and the response:
 *   - Payment policy: an action that declares third-party outflows (split)
 *     goes through PayAI's compliance/risk engine (lib/sdk/policy.ts). A
 *     blocked result is returned as not-ok, so it never becomes a confirmable
 *     card; warnings ride along to the card. Build re-runs it authoritatively.
 *   - Quote token: a signed binding of exactly what was quoted (action
 *     identity, chain, inputs hash, quotedAt, quoteId — lib/sdk/quoteToken.ts).
 *     Build refuses without it, and takes quotedAt only from it.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: { protocolId?: string; actionId?: string; version?: string; inputs?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }

  if (!body.protocolId || !body.actionId || !body.version) {
    return NextResponse.json({ ok: false, message: "protocolId, actionId and version are required." }, { status: 400 });
  }

  const { ActionInputError } = await import("@/lib/sdk/types");
  try {
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { validateForQuote } = await import("@/lib/sdk/validate");
    const { getChain } = await import("@/lib/monad/config");
    const { enforcePaymentPolicy } = await import("@/lib/sdk/policy");
    const { issueQuoteToken } = await import("@/lib/sdk/quoteToken");
    ensureBuiltinsRegistered();

    const chainId = getChain().id;
    const request = {
      protocolId: body.protocolId, actionId: body.actionId, version: body.version,
      inputs: (body.inputs ?? {}) as import("@/lib/sdk/types").ActionInputs,
      // walletAddress isn't needed to PREVIEW (quote() takes only inputs), but
      // ExecutionRequest requires the field — a preview is chain-pinned and
      // freshly timestamped here, and re-validated with a real wallet at build.
      walletAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      chainId, quotedAt: Date.now(),
    };

    const gated = validateForQuote(request, chainId);
    if (!gated.ok) return NextResponse.json({ ok: false, message: gated.message, code: gated.code });

    const { action, protocol, inputs } = gated.value;
    const quote = await action.quote(inputs);

    const policy = action.outflows ? await enforcePaymentPolicy(await action.outflows(inputs)) : null;
    if (policy && !policy.allowed) {
      return NextResponse.json({ ok: false, message: policy.reason ?? "This payment can't be made.", code: "POLICY_BLOCKED" });
    }

    const { quoteToken, quoteId } = issueQuoteToken(
      { protocolId: action.protocolId, actionId: action.actionId, version: action.version, chainId: action.chainId },
      inputs, quote.quotedAt, quote.terms, quote.snapshot,
    );

    return NextResponse.json({
      ok: true,
      protocol: { id: protocol.protocolId, name: protocol.name, logoUrl: protocol.logoUrl ?? null },
      action: { id: action.actionId, name: action.name, description: action.description, version: action.version },
      chainId: action.chainId,
      inputs,
      summary: quote.summary,
      details: quote.details,
      quotedAt: quote.quotedAt,
      quoteToken, quoteId,
      ...(policy ? { risk: { score: policy.riskScore, level: policy.riskLevel, compliance: policy.compliance }, warnings: policy.warnings } : {}),
    });
  } catch (e) {
    if (e instanceof ActionInputError) {
      return NextResponse.json({ ok: false, message: e.message, code: "INVALID_INPUT" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, message: "Couldn't prepare that action right now. Try again in a moment." }, { status: 502 });
  }
}
