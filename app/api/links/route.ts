import { NextRequest, NextResponse } from "next/server";

/**
 * GET  /api/links — list payment links (with lazily-updated expiry status).
 * POST /api/links — create a payment link { amount, memo?, expiresInDays?, walletAddress? }.
 *
 * On the shared demo tenant (no merchant account), listing is scoped to the
 * caller's own wallet — otherwise every wallet-only user's link memos, amounts,
 * and URLs would be visible to every other wallet-only user.
 */
async function senderScopeFor(merchantId: string, walletAddress?: string | null): Promise<string | null> {
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  if (merchantId !== DEMO_TENANT) return null;
  const { isAddress } = await import("@/lib/payees/directory");
  return walletAddress && isAddress(walletAddress) ? walletAddress : "__none__";
}

export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const wallet = new URL(req.url).searchParams.get("wallet");
  const sender = await senderScopeFor(merchantId, wallet);
  const { denyPrivateRead } = await import("@/lib/auth/walletGrant");
  const denied = await denyPrivateRead(req, sender);
  if (denied) return denied;
  const { listLinks } = await import("@/lib/platform/store");
  return NextResponse.json({ links: await listLinks(merchantId, { sender }) });
}

export async function POST(req: NextRequest) {
  // Creating a link never touches the signer (no execution happens here) — it
  // only writes a record, so the platform signer API key is not required. Rate
  // limited so it can't be spammed into a storage-exhaustion vector.
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "write");
  if (limited) return limited;

  let body: { amount?: number; memo?: string; expiresInDays?: number | null; token?: string; walletAddress?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    return NextResponse.json({ ok: false, error: "A positive amount is required." }, { status: 400 });
  }
  // Bound the free-text memo so a link can't be used to stash large blobs.
  const memo = typeof body.memo === "string" ? body.memo.slice(0, 200) : undefined;
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const { getMerchantById, DEMO_TENANT } = await import("@/lib/platform/merchants");
  const { isAddress } = await import("@/lib/payees/directory");
  const merchant = merchantId === DEMO_TENANT ? null : await getMerchantById(merchantId);
  const recipient = merchant?.wallet || process.env.VERIPAYAI_DEMO_PAYOUT_WALLET || undefined;
  const sender = body.walletAddress && isAddress(body.walletAddress) ? body.walletAddress : null;
  const { createLink } = await import("@/lib/platform/store");
  const link = await createLink(merchantId, {
    amount,
    token: body.token,
    memo,
    expiresInDays: body.expiresInDays ?? 7,
    recipient,
    sender,
  });
  return NextResponse.json({ ok: true, link });
}
