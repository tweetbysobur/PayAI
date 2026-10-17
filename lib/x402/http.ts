/**
 * Request handling for PayAI's x402 facilitator routes:
 *
 *   GET  /api/x402/supported   public, what this facilitator relays
 *   POST /api/x402/verify      merchant-only, check a payment without settling
 *   POST /api/x402/settle      merchant-only, broadcast it (PayAI pays the gas)
 *
 * Wire format is the x402 v2 facilitator protocol, so a stock
 * `HTTPFacilitatorClient` works against these routes unchanged:
 *
 *   new HTTPFacilitatorClient({
 *     url: "https://usepayai.xyz/api/x402",
 *     createAuthHeaders: async () => {
 *       const h = { "x-merchant-key": process.env.PAYAI_MERCHANT_KEY! };
 *       return { verify: h, settle: h };
 *     },
 *   })
 *
 * Only a PayAI merchant with a payout wallet can verify or settle, and only
 * payments TO that wallet. PayAI's gas is never spent relaying a payment for
 * someone who isn't a merchant, or to an address the merchant doesn't own.
 *
 * Server-only.
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { readFacilitatorConfig, type FacilitatorConfig } from "./config";
import { checkPaymentPolicy } from "./policy";

const MAX_BODY_BYTES = 16_384;
const USDC_DECIMALS = 6;

type Kind = "verify" | "settle";

function notEnabled(): NextResponse {
  return NextResponse.json({ error: "The PayAI x402 facilitator is not enabled." }, { status: 404 });
}

function failure(kind: Kind, network: string, status: number, reason: string, message: string): NextResponse {
  const body: VerifyResponse | SettleResponse =
    kind === "verify"
      ? { isValid: false, invalidReason: reason, invalidMessage: message }
      : { success: false, errorReason: reason, errorMessage: message, transaction: "", network: network as SettleResponse["network"] };
  return NextResponse.json(body, { status });
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `payai.x402.${event}`, ...fields }));
}

/** Callers rate-limit by IP in the route file before calling this. */
export async function handleSupported(): Promise<NextResponse> {
  const res = readFacilitatorConfig();
  if (!res.ok) return notEnabled();
  const { getFacilitator } = await import("./facilitator");
  const { facilitator } = getFacilitator(res.config);
  return NextResponse.json(facilitator.getSupported(), {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}

async function readBody(req: NextRequest): Promise<
  { ok: true; x402Version: unknown; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } | { ok: false }
> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return { ok: false };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false };
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== "object") return { ok: false };
    if (!body.paymentPayload || typeof body.paymentPayload !== "object") return { ok: false };
    if (!body.paymentRequirements || typeof body.paymentRequirements !== "object") return { ok: false };
    return {
      ok: true,
      x402Version: body.x402Version,
      paymentPayload: body.paymentPayload as PaymentPayload,
      paymentRequirements: body.paymentRequirements as PaymentRequirements,
    };
  } catch {
    return { ok: false };
  }
}

async function handle(req: NextRequest, kind: Kind): Promise<NextResponse> {
  const res = readFacilitatorConfig();
  if (!res.ok) return notEnabled();
  const cfg: FacilitatorConfig = res.config;

  // Authenticate first, so an anonymous caller can't even make PayAI parse a
  // body. Rate-limit per merchant so one merchant can't drain the gas wallet
  // by replaying verify/settle in a loop.
  const apiKey = req.headers.get("x-merchant-key")?.trim();
  if (!apiKey) return failure(kind, cfg.network, 401, "unauthorized", "Send your PayAI merchant key as x-merchant-key.");
  const { getMerchantByApiKey, DEMO_TENANT } = await import("@/lib/platform/merchants");
  const merchant = await getMerchantByApiKey(apiKey);
  if (!merchant || merchant.id === DEMO_TENANT) {
    return failure(kind, cfg.network, 401, "unauthorized", "Unknown merchant key.");
  }
  if (!merchant.wallet) {
    return failure(kind, cfg.network, 403, "no_payout_wallet", "Set a payout wallet on your PayAI merchant account first.");
  }

  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, `x402-${kind}`, {
    max: kind === "settle" ? 60 : 120,
    windowSec: 60,
    subject: merchant.id,
  });
  if (limited) return limited;

  const body = await readBody(req);
  if (!body.ok) return failure(kind, cfg.network, 400, "invalid_request", "Expected { x402Version, paymentPayload, paymentRequirements }.");

  const { ensureSanctionsLoaded, isSanctionedAddress } = await import("@/lib/payment/sanctions");
  await ensureSanctionsLoaded();
  const { getFacilitator } = await import("./facilitator");
  const { facilitator, signerAddresses } = getFacilitator(cfg);

  const policy = checkPaymentPolicy({
    x402Version: body.x402Version,
    paymentPayload: body.paymentPayload,
    paymentRequirements: body.paymentRequirements,
    merchantWallet: merchant.wallet,
    network: cfg.network,
    asset: cfg.asset,
    maxAmountAtomic: cfg.maxAmountAtomic,
    facilitatorAddresses: signerAddresses,
    isSanctioned: isSanctionedAddress,
  });
  if (!policy.ok) {
    log(`${kind}.rejected`, { merchant: merchant.id, reason: policy.reason });
    return failure(kind, cfg.network, 200, policy.reason, policy.message);
  }

  if (kind === "verify") {
    try {
      const result = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
      log("verify", { merchant: merchant.id, valid: result.isValid, reason: result.invalidReason });
      return NextResponse.json(result);
    } catch (e) {
      log("verify.error", { merchant: merchant.id, message: e instanceof Error ? e.message : String(e) });
      return failure(kind, cfg.network, 502, "facilitator_error", "Verification could not be completed. Nothing was charged.");
    }
  }

  let result: SettleResponse;
  try {
    result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
  } catch (e) {
    log("settle.error", { merchant: merchant.id, message: e instanceof Error ? e.message : String(e) });
    return failure(kind, cfg.network, 502, "facilitator_error", "Settlement could not be completed. Retry with the same payment to reconcile.");
  }
  log("settle", { merchant: merchant.id, success: result.success, reason: result.errorReason, tx: result.transaction });

  if (result.success && result.transaction) {
    // Best effort: the money moved on-chain regardless, so a history write
    // failing must not turn a settled payment into an error response.
    try {
      const { recordTx } = await import("@/lib/platform/store");
      const { getChain } = await import("@/lib/monad/config");
      const explorer = getChain().blockExplorers?.default.url;
      await recordTx(merchant.id, {
        decision: "executed",
        action: "x402_settle",
        feature: "payment",
        amount: Number(policy.amountAtomic) / 10 ** USDC_DECIMALS,
        token: "USDC",
        recipient: merchant.wallet,
        sender: policy.payer,
        riskScore: null,
        compliance: "screened",
        txHash: result.transaction,
        explorerUrl: explorer ? `${explorer}/tx/${result.transaction}` : undefined,
        summary: `x402 payment received from ${policy.payer}`,
      });
    } catch (e) {
      log("settle.record_failed", { merchant: merchant.id, tx: result.transaction, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json(result);
}

export const handleVerify = (req: NextRequest) => handle(req, "verify");
export const handleSettle = (req: NextRequest) => handle(req, "settle");
