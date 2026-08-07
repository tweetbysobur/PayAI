import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/links/{id}/confirm — confirm a customer's on-chain USDC transfer
 * and mark the link paid. Body: { txHash }.
 *
 * The client only reports a tx hash; this endpoint independently reads the
 * transaction receipt from the chain and checks the ERC20 Transfer log
 * (correct token, correct recipient, amount >= what's owed) before trusting
 * it — a client could otherwise claim any hash as proof of payment.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "confirm");
  if (limited) return limited;

  const { id } = await params;
  let body: { txHash?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const txHash = body.txHash?.trim();
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ ok: false, error: "A valid txHash is required." }, { status: 400 });
  }

  const { getLinkGlobal, markLinkPaid } = await import("@/lib/platform/store");
  const link = await getLinkGlobal(id);
  if (!link) return NextResponse.json({ ok: false, error: "Link not found." }, { status: 404 });
  if (link.status === "paid") return NextResponse.json({ ok: true, link });
  if (link.status !== "active") return NextResponse.json({ ok: false, error: `Link is ${link.status}.` }, { status: 409 });
  if (!link.recipient) return NextResponse.json({ ok: false, error: "This link has no payout wallet configured." }, { status: 409 });

  // One transaction settles one invoice. The receipt check below only asks
  // "did at least `amount` reach `recipient` in this tx" — which a single
  // large payment to a merchant satisfies for every small invoice they have
  // open, so without this a customer could clear ten 10-USDC invoices with
  // one 100-USDC transfer. Claiming the hash globally binds it to the first
  // invoice it settles; a second link presenting the same hash is refused.
  // It doubles as the concurrency guard on the recordTx below, so two
  // simultaneous confirms of the same payment can't book the revenue twice.
  const { claimRequest, completeRequest, releaseRequest } = await import("@/lib/platform/idempotency");
  const settleKey = `link-settle:${txHash.toLowerCase()}`;
  const claim = await claimRequest<{ ok: boolean; linkId: string }>(settleKey);
  if (!claim.claimed) {
    if (claim.status === "done" && claim.result?.linkId === id) {
      return NextResponse.json({ ok: true, link });
    }
    return NextResponse.json(
      { ok: false, error: "That transaction has already been used to pay an invoice." },
      { status: 409 },
    );
  }

  const { getChain, getTransport } = await import("@/lib/monad/config");
  const { createPublicClient } = await import("viem");
  const client = createPublicClient({ chain: getChain(), transport: getTransport() });

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (e) {
    const notMinedYet = e instanceof Error && /could not be found|not found/i.test(e.message);
    if (!notMinedYet) {
      await releaseRequest(settleKey);
      return NextResponse.json({ ok: false, error: "Could not reach the Monad network to verify this transaction. Please retry." }, { status: 503 });
    }
    receipt = null;
  }
  if (!receipt || receipt.status !== "success") {
    // Not mined yet is a "come back shortly", not a verdict — release so the
    // retry isn't blocked by its own earlier attempt.
    await releaseRequest(settleKey);
    return NextResponse.json({ ok: false, error: "Transaction not found or not successful yet." }, { status: 409 });
  }

  // Use the network-aware stablecoin (MONAD_MAINNET_USDC on mainnet), NOT a
  // hardcoded testnet address — otherwise on mainnet this checks the wrong
  // token and no legitimate payment ever verifies. Matches /api/agent/confirm.
  const { getStablecoin } = await import("@/lib/monad/config");
  const { hasErc20TransferTo, toBaseUnits } = await import("@/lib/monad/verify");
  const stablecoin = getStablecoin();
  const wanted = toBaseUnits(link.amount, stablecoin.decimals);
  const matched = hasErc20TransferTo(receipt.logs, stablecoin.address, link.recipient, wanted);

  if (!matched) {
    await releaseRequest(settleKey);
    return NextResponse.json({ ok: false, error: "Transaction does not match this invoice (wrong token, recipient, or amount)." }, { status: 409 });
  }

  const updated = await markLinkPaid(id, txHash);

  // Surface this in the merchant's revenue/analytics/top-customers exactly like
  // an agent-settled payment — otherwise customer-paid invoices are invisible
  // on the dashboard even though the funds really moved.
  const { recordTx } = await import("@/lib/platform/store");
  const { explorerTx } = await import("@/lib/monad/config");
  await recordTx(link.merchantId, {
    decision: "executed",
    action: "invoice_payment",
    feature: "payment",
    amount: link.amount,
    token: link.token,
    // The invoice's payout wallet is who received the money; `receipt.from` is
    // the customer who paid it. Recording the payer as the recipient made the
    // dashboard's "To" column name the wrong party.
    recipient: link.recipient,
    // Scoped to whoever created the link. Every wallet-scoped read
    // (history, analytics, top customers) filters on `sender`, so a row
    // without one is invisible to the person whose invoice was just paid —
    // the money arrived and their dashboard showed nothing.
    sender: link.sender ?? null,
    riskScore: null,
    compliance: "approved",
    txHash,
    explorerUrl: explorerTx(txHash),
    summary: `Customer paid invoice ${id} (${link.amount} ${link.token}) via wallet-connect.`,
  });

  await completeRequest(settleKey, { ok: true, linkId: id });
  return NextResponse.json({ ok: true, link: updated });
}
