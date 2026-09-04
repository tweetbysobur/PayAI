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
 *   1. resolveExecutable — the EXACT pinned protocolId/actionId/version, on
 *      the active chain, with a fresh quote. A newer version registered since
 *      preview never takes over: this resolves the pinned version or refuses.
 *   2. validateInputs (Layer A) — every input against the action's schema.
 *   3. quote() then build() — only after validation passes.
 *   4. validateSteps (Layer B) — every returned step's target must be in BOTH
 *      the action's and the protocol's allowlists. One bad target rejects the
 *      ENTIRE action; there is no partial build.
 *
 * The client never supplies — and this route never accepts — a transaction
 * target, calldata, or value. Those are derived here from the reviewed action
 * and then re-validated against the allowlists before being returned.
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
    inputs?: Record<string, string>; walletAddress?: string | null; quotedAt?: number;
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
  if (!body.walletAddress || !isAddress(body.walletAddress.trim())) {
    return NextResponse.json({ ok: false, message: "Connect your wallet to run this action." }, { status: 400 });
  }

  try {
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { resolveExecutable, validateInputs, validateSteps } = await import("@/lib/sdk/validate");
    const { getChain } = await import("@/lib/monad/config");
    ensureBuiltinsRegistered();

    const chainId = getChain().id;
    const request = {
      protocolId: body.protocolId, actionId: body.actionId, version: body.version,
      inputs: (body.inputs ?? {}) as Readonly<Record<string, string>>,
      walletAddress: body.walletAddress.trim() as `0x${string}`,
      chainId,
      // The quote's own timestamp, carried from the preview, so freshness is
      // judged against when the user was actually quoted — not "now".
      quotedAt: typeof body.quotedAt === "number" ? body.quotedAt : Date.now(),
    };

    // 1. Resolve the exact pinned action, on the active chain, fresh quote.
    const resolved = resolveExecutable(request, chainId);
    if (!resolved.ok) return NextResponse.json({ ok: false, message: resolved.message, code: resolved.code });
    const { action, protocol } = resolved.value;

    // 2. Layer A.
    const validInputs = validateInputs(action.inputSchema, request.inputs);
    if (!validInputs.ok) return NextResponse.json({ ok: false, message: validInputs.message, code: validInputs.code });

    // 3. Quote then build — only now, after both gates passed.
    const quote = await action.quote(validInputs.value);
    const steps = await action.build(validInputs.value, quote);

    // 4. Layer B — the hard invariant. Validate BEFORE returning anything the
    // client could sign. A single out-of-allowlist target rejects everything.
    const validated = validateSteps(steps, action, protocol);
    if (!validated.ok) return NextResponse.json({ ok: false, message: validated.message, code: validated.code });

    return NextResponse.json({
      ok: true,
      // Shape matches the existing UnsignedStep the wallet loop already
      // consumes: { kind, label, tx: { to, data, value } }.
      steps: validated.value,
      summary: quote.summary,
      details: quote.details,
    });
  } catch {
    return NextResponse.json({ ok: false, message: "Couldn't prepare that action. Try again in a moment." }, { status: 502 });
  }
}
