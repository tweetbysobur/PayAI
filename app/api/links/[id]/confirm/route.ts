import { NextRequest, NextResponse } from "next/server";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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

  const { getChain, getTransport } = await import("@/lib/monad/config");
  const { createPublicClient } = await import("viem");
  const client = createPublicClient({ chain: getChain(), transport: getTransport() });

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (e) {
    const notMinedYet = e instanceof Error && /could not be found|not found/i.test(e.message);
    if (!notMinedYet) {
      return NextResponse.json({ ok: false, error: "Could not reach the Monad network to verify this transaction. Please retry." }, { status: 503 });
    }
    receipt = null;
  }
  if (!receipt || receipt.status !== "success") {
    return NextResponse.json({ ok: false, error: "Transaction not found or not successful yet." }, { status: 409 });
  }

  // Use the network-aware stablecoin (MONAD_MAINNET_USDC on mainnet), NOT a
  // hardcoded testnet address — otherwise on mainnet this checks the wrong
  // token and no legitimate payment ever verifies. Matches /api/agent/confirm.
  const { getStablecoin } = await import("@/lib/monad/config");
  const stablecoin = getStablecoin();
  const usdc = stablecoin.address.toLowerCase();
  const decimals = stablecoin.decimals;
  const wanted = BigInt(Math.round(link.amount * 10 ** decimals));
  const recipient = link.recipient.toLowerCase();

  const matched = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== usdc) return false;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
    const to = log.topics[2] ? `0x${log.topics[2].slice(-40)}`.toLowerCase() : "";
    if (to !== recipient) return false;
    const amount = BigInt(log.data);
    return amount >= wanted;
  });

  if (!matched) {
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
    amount: link.amount,
    token: link.token,
    recipient: receipt.from,
    riskScore: null,
    compliance: "approved",
    txHash,
    explorerUrl: explorerTx(txHash),
    summary: `Customer paid invoice ${id} (${link.amount} ${link.token}) via wallet-connect.`,
  });

  return NextResponse.json({ ok: true, link: updated });
}
