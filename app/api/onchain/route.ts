import { NextRequest, NextResponse } from "next/server";

/**
 * GET  /api/onchain — on-chain analytics + payment history + merchants, read
 *                     live from the PaymentExecutor + MerchantRegistry contracts.
 *                     Powers the dashboard's analytics, history, compliance
 *                     history, event viewer, and merchant management panels.
 * POST /api/onchain — register a merchant on-chain { wallet, name }.
 *
 * Returns empty/zeroed data (not an error) when the suite isn't configured, so
 * the dashboard degrades gracefully in mock mode.
 */
export async function GET() {
  try {
    const { executorEnabled, getOnchainStats, getOnchainPayments, getOnchainMerchants, getOnchainRequests } =
      await import("@/lib/monad/contracts");
    const { explorerTx, explorerAddress, getPaymentExecutor, getMerchantRegistry } =
      await import("@/lib/monad/config");

    if (!executorEnabled()) {
      return NextResponse.json({ configured: false, stats: null, payments: [], merchants: [], requests: [] });
    }

    const [stats, payments, merchants, requests] = await Promise.all([
      getOnchainStats(),
      getOnchainPayments(25),
      getOnchainMerchants(),
      getOnchainRequests(),
    ]);

    return NextResponse.json({
      configured: true,
      contracts: {
        paymentExecutor: getPaymentExecutor(),
        merchantRegistry: getMerchantRegistry(),
        executorExplorer: explorerAddress(getPaymentExecutor() ?? ""),
      },
      stats,
      payments,
      merchants,
      requests,
      explorerTxBase: explorerTx(""),
    });
  } catch (e) {
    return NextResponse.json(
      { configured: false, error: e instanceof Error ? e.message : "read failed", stats: null, payments: [], merchants: [] },
      { status: 200 },
    );
  }
}

/**
 * POST actions:
 *   { action: "register_merchant", wallet, name }
 *   { action: "create_request",    merchant, amount, ref? }
 *   { action: "pay_request",       requestId, riskScore? }
 * (Defaults to register_merchant when action is omitted, for back-compat.)
 */
export async function POST(req: NextRequest) {
  const { authError } = await import("@/lib/platform/auth");
  const denied = authError(req);
  if (denied) return denied;
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "onchain");
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const action = (body.action as string) || "register_merchant";
  const ADDR = /^0x[0-9a-fA-F]{40}$/;

  try {
    const c = await import("@/lib/monad/contracts");

    if (action === "register_merchant") {
      const wallet = String(body.wallet ?? "").trim();
      const name = String(body.name ?? "").trim();
      if (!ADDR.test(wallet) || !name) {
        return NextResponse.json({ ok: false, error: "Valid 0x wallet and name are required." }, { status: 400 });
      }
      return NextResponse.json({ ok: true, ...(await c.registerMerchant(wallet as `0x${string}`, name)) });
    }

    if (action === "create_request") {
      const merchant = String(body.merchant ?? "").trim();
      const amount = Number(body.amount);
      if (!ADDR.test(merchant) || !Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ ok: false, error: "Valid 0x merchant and positive amount required." }, { status: 400 });
      }
      return NextResponse.json({ ok: true, ...(await c.createPaymentRequest(merchant as `0x${string}`, amount, (body.ref as string) ?? null)) });
    }

    if (action === "pay_request") {
      const requestId = Number(body.requestId);
      if (!Number.isInteger(requestId) || requestId < 0) {
        return NextResponse.json({ ok: false, error: "Valid requestId required." }, { status: 400 });
      }
      const riskScore = Number.isFinite(Number(body.riskScore)) ? Number(body.riskScore) : 0;
      const { computeRequestId } = await import("@/lib/platform/idempotency");
      const idempotencyKey = (body.idempotencyKey as string) || computeRequestId({ action: "pay_request", requestId });
      return NextResponse.json({ ok: true, ...(await c.payRequest(requestId, riskScore, "invoice payment", idempotencyKey)) });
    }

    return NextResponse.json({ ok: false, error: `Unknown action "${action}".` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Action failed." },
      { status: 502 },
    );
  }
}
