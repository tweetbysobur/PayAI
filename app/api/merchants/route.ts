import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/merchants — self-serve merchant signup.
 * Body: { name, wallet? } → creates a tenant and returns { id, apiKey }.
 * The apiKey is shown ONCE; the client stores it and sends it as `x-merchant-key`
 * on subsequent requests to scope all data to this merchant.
 *
 * GET /api/merchants?id=… — public merchant info (never returns the apiKey).
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "signup");
  if (limited) return limited;

  let body: { name?: string; wallet?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ ok: false, error: "A business name is required." }, { status: 400 });
  const wallet = body.wallet?.trim();
  if (wallet && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return NextResponse.json({ ok: false, error: "wallet must be a valid 0x address." }, { status: 400 });
  }

  const { createMerchant } = await import("@/lib/platform/merchants");
  const m = await createMerchant(name, wallet);
  // apiKey returned once — never retrievable again.
  return NextResponse.json({ ok: true, id: m.id, name: m.name, apiKey: m.apiKey });
}

/**
 * PATCH /api/merchants — set the calling merchant's payout wallet.
 * Auth: `x-merchant-key: <apiKey>`. Body: { wallet }.
 */
export async function PATCH(req: NextRequest) {
  const key = req.headers.get("x-merchant-key")?.trim();
  if (!key) return NextResponse.json({ ok: false, error: "x-merchant-key is required." }, { status: 401 });

  let body: { wallet?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const wallet = body.wallet?.trim();
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return NextResponse.json({ ok: false, error: "wallet must be a valid 0x address." }, { status: 400 });
  }

  const { getMerchantByApiKey, setMerchantWallet } = await import("@/lib/platform/merchants");
  const m = await getMerchantByApiKey(key);
  if (!m) return NextResponse.json({ ok: false, error: "Invalid API key." }, { status: 401 });
  const updated = await setMerchantWallet(m.id, wallet);
  return NextResponse.json({ ok: true, wallet: updated?.wallet });
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const { getMerchantById, publicMerchant } = await import("@/lib/platform/merchants");
  const m = await getMerchantById(id);
  if (!m) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(publicMerchant(m));
}
