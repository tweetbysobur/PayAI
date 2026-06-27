import { NextRequest, NextResponse } from "next/server";

/**
 * GET  /api/links — list payment links (with lazily-updated expiry status).
 * POST /api/links — create a payment link { amount, memo?, expiresInDays? }.
 */
export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const { listLinks } = await import("@/lib/platform/store");
  return NextResponse.json({ links: await listLinks(merchantId) });
}

export async function POST(req: NextRequest) {
  // Creating a link never touches the signer (no execution happens here) — it
  // only writes a record, so the platform signer API key is not required.
  let body: { amount?: number; memo?: string; expiresInDays?: number | null; token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ ok: false, error: "A positive amount is required." }, { status: 400 });
  }
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const { getMerchantById, DEMO_TENANT } = await import("@/lib/platform/merchants");
  const merchant = merchantId === DEMO_TENANT ? null : await getMerchantById(merchantId);
  const recipient = merchant?.wallet || process.env.VERIPAYAI_DEMO_PAYOUT_WALLET || undefined;
  const { createLink } = await import("@/lib/platform/store");
  const link = await createLink(merchantId, {
    amount,
    token: body.token,
    memo: body.memo,
    expiresInDays: body.expiresInDays ?? 7,
    recipient,
  });
  return NextResponse.json({ ok: true, link });
}
