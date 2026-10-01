import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/ask/action/build — the ONLY place an SDK protocol action's real
 * unsigned steps are constructed. Called exactly once, from an explicit
 * "Confirm" click on an already-previewed card (see orchestrate.ts's
 * executeProtocolActionIntent) — never from a preview render, never
 * automatically. Mirrors /api/ask/trade/build's role for trades.
 *
 * Full server-side gate, in order, all fail-closed (Phase 1 validators are
 * authoritative — nothing is re-implemented here):
 *   1. quote token — REQUIRED. The preview's signed binding of the action
 *      identity, chain, exact inputs, quotedAt and quoteId
 *      (lib/sdk/quoteToken.ts). quotedAt comes ONLY from the verified token;
 *      a request body can't supply or refresh it, and a missing token is a
 *      refusal, not "now".
 *   2. resolveExecutable — the EXACT pinned protocolId/actionId/version, on
 *      the active chain, with a fresh quote (age judged from the token).
 *   3. validateInputs (Layer A) — every input against the action's schema;
 *      the validated inputs must hash to exactly what the token covers.
 *   4. payment policy — an action with third-party outflows goes through
 *      PayAI's compliance/risk engine (lib/sdk/policy.ts), authoritatively.
 *   5. one build per quote — the quoteId is claimed (lib/platform/
 *      idempotency.ts). A second build of the same quote is refused, so one
 *      preview can't hand out two sets of signable steps.
 *   6. quote() then build(), then validateSteps (Layer B) — every returned
 *      step's target must be in BOTH allowlists. One bad target rejects the
 *      ENTIRE action; there is no partial build.
 *
 * The client never supplies — and this route never accepts — a transaction
 * target, calldata, or value. The built steps are stored under the quoteId
 * so /api/ask/action/confirm can prove a confirmed transaction is exactly
 * the one built here.
 *
 * Requires walletAddress: building real steps needs the signer's own address
 * (the action's build receives validated inputs; the wallet is the executor).
 */

export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: {
    protocolId?: string; actionId?: string; version?: string;
    inputs?: unknown; walletAddress?: string | null; quoteToken?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }

  if (!body.protocolId || !body.actionId || !body.version) {
    return NextResponse.json({ ok: false, message: "protocolId, actionId and version are required." }, { status: 400 });
  }
  const { isAddress } = await import("@/lib/payees/directory");
  if (typeof body.walletAddress !== "string" || !isAddress(body.walletAddress.trim())) {
    return NextResponse.json({ ok: false, message: "Connect your wallet to run this action." }, { status: 400 });
  }
  if (typeof body.quoteToken !== "string" || !body.quoteToken) {
    return NextResponse.json({ ok: false, message: "A fresh preview is required before this action can be built.", code: "QUOTE_REQUIRED" }, { status: 400 });
  }

  const { ActionInputError } = await import("@/lib/sdk/types");
  const { claimRequest, completeRequest, releaseRequest } = await import("@/lib/platform/idempotency");
  let claimedKey: string | null = null;
  try {
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { resolveExecutable, validateInputs, validateSteps } = await import("@/lib/sdk/validate");
    const { getChain } = await import("@/lib/monad/config");
    const { verifyQuoteToken } = await import("@/lib/sdk/quoteToken");
    const { enforcePaymentPolicy } = await import("@/lib/sdk/policy");
    const { buildKey } = await import("@/lib/sdk/settlement");
    ensureBuiltinsRegistered();

    const chainId = getChain().id;
    const walletAddress = body.walletAddress.trim() as `0x${string}`;
    const rawInputs = (body.inputs ?? {}) as import("@/lib/sdk/types").ActionInputs;

    // Layer A first (it needs only the schema, which resolveExecutable below
    // re-derives from the SAME pinned identity) so the token can be checked
    // against the exact validated inputs.
    const { getAction } = await import("@/lib/sdk/registry");
    const pinned = getAction(body.protocolId, body.actionId, body.version);
    if (!pinned) {
      // Let resolveExecutable produce the precise reason (unknown protocol,
      // unknown action, version mismatch).
      const r = resolveExecutable({ protocolId: body.protocolId, actionId: body.actionId, version: body.version, inputs: rawInputs, walletAddress, chainId, quotedAt: 0 }, chainId);
      return NextResponse.json({ ok: false, message: r.ok ? "Unknown action." : r.message, code: r.ok ? "ACTION_NOT_FOUND" : r.code });
    }
    const validInputs = validateInputs(pinned.inputSchema, rawInputs);
    if (!validInputs.ok) return NextResponse.json({ ok: false, message: validInputs.message, code: validInputs.code });

    // 1. The quote token must cover exactly this action, chain and inputs.
    const token = verifyQuoteToken(body.quoteToken, {
      protocolId: body.protocolId, actionId: body.actionId, version: body.version, chainId,
    }, validInputs.value);
    if (!token.ok) return NextResponse.json({ ok: false, message: token.message, code: "QUOTE_REQUIRED" });

    // 2. Resolve the exact pinned action, on the active chain, with quotedAt
    // taken from the VERIFIED token — never from the request.
    const resolved = resolveExecutable({
      protocolId: body.protocolId, actionId: body.actionId, version: body.version,
      inputs: validInputs.value, walletAddress, chainId, quotedAt: token.quotedAt,
    }, chainId);
    if (!resolved.ok) return NextResponse.json({ ok: false, message: resolved.message, code: resolved.code });
    const { action, protocol } = resolved.value;

    // 4. Payment policy, authoritatively (the preview's run was for display).
    const policy = action.outflows ? await enforcePaymentPolicy(await action.outflows(validInputs.value)) : null;
    if (policy && !policy.allowed) {
      return NextResponse.json({ ok: false, message: policy.reason ?? "This payment can't be made.", code: "POLICY_BLOCKED" });
    }

    // 5. One build per quote.
    const key = buildKey(token.quoteId);
    const claim = await claimRequest<import("@/lib/sdk/settlement").BuildRecord>(key);
    if (!claim.claimed) {
      return NextResponse.json({
        ok: false, code: "ALREADY_BUILT",
        message: "This preview was already used to prepare a transaction. Check your wallet and activity before trying again — request a fresh preview if you need to.",
      }, { status: 409 });
    }
    claimedKey = key;

    // 6. Quote then build — only now, after every gate passed — then Layer B.
    const quote = await action.quote(validInputs.value);
    const steps = await action.build(validInputs.value, quote);
    const validated = validateSteps(steps, action, protocol);
    if (!validated.ok) {
      await releaseRequest(key);
      claimedKey = null;
      return NextResponse.json({ ok: false, message: validated.message, code: validated.code });
    }

    const final = validated.value[validated.value.length - 1];
    const record: import("@/lib/sdk/settlement").BuildRecord = {
      protocolId: action.protocolId, actionId: action.actionId, version: action.version,
      wallet: walletAddress.toLowerCase(),
      finalTx: { to: final.tx.to, data: final.tx.data, value: final.tx.value },
      riskScore: policy?.riskScore ?? null,
      compliance: policy?.compliance ?? null,
      builtAt: Date.now(),
    };
    await completeRequest(key, record);
    claimedKey = null;

    return NextResponse.json({
      ok: true,
      // Shape matches the existing UnsignedStep the wallet loop already
      // consumes: { kind, label, tx: { to, data, value } }.
      steps: validated.value,
      summary: quote.summary,
      details: quote.details,
      quoteId: token.quoteId,
    });
  } catch (e) {
    if (claimedKey) await releaseRequest(claimedKey).catch(() => {});
    if (e instanceof ActionInputError) {
      return NextResponse.json({ ok: false, message: e.message, code: "INVALID_INPUT" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, message: "Couldn't prepare that action. Try again in a moment." }, { status: 502 });
  }
}
