import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/ask/action/confirm — verify a protocol action's transaction
 * on-chain and turn its receipt into display details via the action's own
 * parseResult().
 *
 * Same trust model as /api/swap/confirm: the on-chain receipt is the source
 * of truth, never the client's word. We fetch the receipt with the app's
 * existing public client, require it to have been sent BY the declared wallet
 * (so nobody can claim someone else's transaction as their own), and only
 * then call the reviewed action's parseResult on the real logs. It reuses the
 * existing chain-read client — it does NOT introduce a second settlement
 * ledger; Phase 2 records nothing to the merchant transaction log (a wrap is
 * the user's own balance move, already discoverable by balanceOf), so there
 * is no trusted server state a lying client could corrupt here.
 *
 * parseResult never throws (see the action's own doc) and this route never
 * signs or builds — it only reads and formats.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "confirm");
  if (limited) return limited;

  let body: { protocolId?: string; actionId?: string; version?: string; txHash?: string; walletAddress?: string };
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

  try {
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { getAction } = await import("@/lib/sdk/registry");
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const { explorerTx } = await import("@/lib/monad/config");
    ensureBuiltinsRegistered();

    const action = getAction(body.protocolId, body.actionId, body.version);
    if (!action) return NextResponse.json({ ok: false, message: "Unknown action.", code: "ACTION_NOT_FOUND" }, { status: 400 });

    const pub = getPublicClient();
    const explorerUrl = explorerTx(body.txHash);
    let receipt;
    try {
      receipt = await pub.waitForTransactionReceipt({ hash: body.txHash as `0x${string}`, timeout: 90_000 });
    } catch {
      return NextResponse.json({ ok: false, message: "Couldn't confirm that on-chain yet. Check the explorer — it may still settle.", explorerUrl }, { status: 502 });
    }

    // Must have been sent by the declared wallet — same guard /api/swap/confirm
    // applies, so nobody can point at an unrelated tx as "proof".
    if (receipt.from.toLowerCase() !== body.walletAddress.toLowerCase()) {
      return NextResponse.json({ ok: false, message: "Transaction was not sent from the declared wallet." }, { status: 409 });
    }

    const details = await action.parseResult({
      status: receipt.status === "success" ? "success" : "reverted",
      txHash: body.txHash as `0x${string}`,
      logs: receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
    });

    if (receipt.status !== "success") {
      return NextResponse.json({ ok: false, reverted: true, message: "The transaction reverted on-chain. No funds moved.", explorerUrl, details });
    }
    return NextResponse.json({ ok: true, success: true, explorerUrl, details });
  } catch {
    return NextResponse.json({ ok: false, message: "Couldn't verify that action on-chain. Try again in a moment." }, { status: 502 });
  }
}
