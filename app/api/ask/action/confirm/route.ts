import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/ask/action/confirm — verify a protocol action's transaction
 * on-chain, turn its receipt into display details via the action's own
 * parseResult(), and record what actually settled.
 *
 * Same trust model as /api/swap/confirm: the on-chain receipt is the source
 * of truth, never the client's word. In order:
 *
 *   1. The build record for the quote (`sdk-build:<quoteId>`, written by
 *      /api/ask/action/build) must exist and be for this wallet + action.
 *   2. The tx hash is claimed (`sdk-settle:<txHash>`) so one transaction is
 *      settled and recorded once; a repeat replays the stored outcome.
 *   3. The mined transaction must be byte-for-byte the one built for that
 *      quote — sender, target, calldata (incl. split's per-build `ref`) and
 *      value (lib/sdk/settlement.ts's matchesBuiltTx). Pointing at someone
 *      else's transaction, or a different one of your own, is refused.
 *   4. parseResult() on the real logs for display; on success, history is
 *      written from settledOutflows() — the CANONICAL on-chain event's own
 *      recipients and amounts, one row per confirmed recipient — never from
 *      the preview or the request.
 *
 * Exactly-once is NOT claimed: the deployed contracts don't enforce `ref`
 * uniqueness, so if the same built transaction is signed twice, both settle
 * on-chain. Each is then recorded once, as the real separate settlement it is.
 * The idempotency store is authoritative across instances only when KV is
 * configured (lib/platform/idempotency.ts); without it, best-effort per
 * instance.
 *
 * parseResult never throws (see the action's own doc) and this route never
 * signs or builds — it only reads, matches, records and formats.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "confirm");
  if (limited) return limited;

  let body: { protocolId?: string; actionId?: string; version?: string; txHash?: string; walletAddress?: string; quoteId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }

  if (!body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    return NextResponse.json({ ok: false, message: "A valid txHash is required." }, { status: 400 });
  }
  const { isAddress } = await import("@/lib/payees/directory");
  if (!body.walletAddress || !isAddress(body.walletAddress)) {
    return NextResponse.json({ ok: false, message: "A valid walletAddress is required." }, { status: 400 });
  }
  if (!body.protocolId || !body.actionId || !body.version) {
    return NextResponse.json({ ok: false, message: "protocolId, actionId and version are required." }, { status: 400 });
  }
  if (typeof body.quoteId !== "string" || !/^[0-9a-f]{32}$/.test(body.quoteId)) {
    return NextResponse.json({ ok: false, message: "A valid quoteId is required." }, { status: 400 });
  }

  const txHash = body.txHash as `0x${string}`;
  const wallet = body.walletAddress.toLowerCase();
  const { claimRequest, completeRequest, peekRequest, releaseRequest } = await import("@/lib/platform/idempotency");
  const { buildKey, settleKey, matchesBuiltTx } = await import("@/lib/sdk/settlement");
  type BuildRecord = import("@/lib/sdk/settlement").BuildRecord;

  // 1. The build this confirm is for.
  const record = await peekRequest<BuildRecord>(buildKey(body.quoteId));
  if (!record || record.wallet !== wallet || record.protocolId !== body.protocolId || record.actionId !== body.actionId || record.version !== body.version) {
    return NextResponse.json({ ok: false, message: "No matching prepared transaction was found for this confirmation." }, { status: 409 });
  }

  // 2. One settlement per transaction hash.
  const sKey = settleKey(txHash);
  const claim = await claimRequest<Record<string, unknown>>(sKey);
  if (!claim.claimed) {
    if (claim.status === "done" && claim.result) return NextResponse.json({ ...claim.result, replayed: true });
    return NextResponse.json({ ok: false, message: "This confirmation is already being processed." }, { status: 409 });
  }

  try {
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { getAction } = await import("@/lib/sdk/registry");
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const { explorerTx } = await import("@/lib/monad/config");
    ensureBuiltinsRegistered();

    const action = getAction(body.protocolId, body.actionId, body.version);
    if (!action) {
      await releaseRequest(sKey);
      return NextResponse.json({ ok: false, message: "Unknown action.", code: "ACTION_NOT_FOUND" }, { status: 400 });
    }

    const pub = getPublicClient();
    const explorerUrl = explorerTx(txHash);
    let receipt;
    let tx;
    try {
      receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
      tx = await pub.getTransaction({ hash: txHash });
    } catch {
      await releaseRequest(sKey);
      return NextResponse.json({ ok: false, message: "Couldn't confirm that on-chain yet. Check the explorer — it may still settle.", explorerUrl }, { status: 502 });
    }

    // Must have been sent by the declared wallet — same guard /api/swap/confirm
    // applies, so nobody can point at an unrelated tx as "proof".
    if (receipt.from.toLowerCase() !== wallet) {
      await releaseRequest(sKey);
      return NextResponse.json({ ok: false, message: "Transaction was not sent from the declared wallet." }, { status: 409 });
    }
    // 3. And it must be exactly the transaction PayAI built for this quote.
    if (!matchesBuiltTx(record, { from: tx.from, to: tx.to, input: tx.input, value: tx.value })) {
      await releaseRequest(sKey);
      return NextResponse.json({ ok: false, message: "That transaction doesn't match the one prepared for this action." }, { status: 409 });
    }

    const actionReceipt = {
      status: receipt.status === "success" ? "success" as const : "reverted" as const,
      txHash,
      logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    };
    // The terms the transaction was BUILT on (e.g. split's fee treasury and
    // amount) — how the result tells the fee leg apart from recipients.
    const resultCtx = { terms: record.terms };
    const details = await action.parseResult(actionReceipt, resultCtx);

    if (receipt.status !== "success") {
      // A mined revert is final for this hash: complete (not release) so a
      // re-ask replays it. Nothing settled, so nothing goes into history.
      const revertBody = { ok: false, reverted: true, message: "The transaction reverted on-chain. No funds moved.", explorerUrl, details };
      await completeRequest(sKey, revertBody);
      return NextResponse.json(revertBody);
    }

    // 4. History from the canonical on-chain event only: one row per USER
    // recipient. The platform fee is never a recipient row — it is recorded
    // on the settlement every row shares.
    const settledAll = action.settledOutflows
      ? await action.settledOutflows(actionReceipt, resultCtx)
      : { recipients: [], fee: null };
    const settled = settledAll.recipients;
    if (settled.length > 0) {
      const { formatUnits } = await import("viem");
      const { resolveTenantId } = await import("@/lib/platform/tenant");
      const { recordTx } = await import("@/lib/platform/store");
      const merchantId = await resolveTenantId(req);
      const ref = details.settlementId ? ` (settlement #${details.settlementId})` : "";
      const recipientTotal = settled.reduce((s, o) => s + o.amountUnits, 0n);
      const platformFee = settledAll.fee?.amountUnits ?? 0n;
      const settlement = {
        id: details.settlementId ?? null,
        recipientCount: settled.length,
        token: settled[0].symbol,
        decimals: settled[0].decimals,
        recipientTotal: recipientTotal.toString(),
        platformFee: platformFee.toString(),
        treasury: settledAll.fee?.treasury ?? null,
        grossPaid: (recipientTotal + platformFee).toString(),
      };
      for (let i = 0; i < settled.length; i++) {
        const o = settled[i];
        const shown = o.decimals > 0 ? formatUnits(o.amountUnits, o.decimals) : o.amountUnits.toString();
        await recordTx(merchantId, {
          decision: "executed",
          action: action.actionId,
          feature: "payment",
          // TxLogEntry.amount is a display number; the exact base-unit amount
          // is preserved in the summary text.
          amount: Number(shown),
          token: o.symbol,
          recipient: o.recipient,
          sender: wallet,
          riskScore: record.riskScore,
          compliance: record.compliance,
          txHash,
          explorerUrl,
          summary: `${action.name} ${i + 1}/${settled.length}: ${shown} ${o.symbol} to ${o.recipient}${ref}`,
          settlement,
        });
      }
    }

    const okBody = { ok: true, success: true, explorerUrl, details, recorded: settled.length };
    await completeRequest(sKey, okBody);
    return NextResponse.json(okBody);
  } catch {
    await releaseRequest(sKey).catch(() => {});
    return NextResponse.json({ ok: false, message: "Couldn't verify that action on-chain. Try again in a moment." }, { status: 502 });
  }
}
