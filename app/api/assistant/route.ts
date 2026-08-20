import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";

/**
 * POST /api/assistant — the AI Payment Assistant.
 * Answers natural-language questions over the caller's own data and performs
 * quick actions (create payment link / invoice). Key-free.
 * Body: { question: string, walletAddress?: string }
 */
export async function POST(req: NextRequest) {
  let body: { question?: string; walletAddress?: string };
  try {
    body = (await req.json()) as { question?: string; walletAddress?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "assistant");
  if (limited) return limited;

  const question = body.question?.trim();
  if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  const merchantId = await resolveTenantId(req);

  // Same wallet scoping /api/agent's read-only queries already use, and for
  // the same reason: wallet-only users all share DEMO_TENANT, so an unscoped
  // read there would answer "show me recent transactions" with everyone
  // else's payments — senders, amounts and counterparties included. Fails
  // closed: no connected wallet on the shared tenant means the sentinel
  // "__none__", which matches no sender, rather than the whole tenant.
  // A real merchant tenant is only reachable with its own secret apiKey, so
  // null (full tenant view) is correct there — it's their own data.
  const walletAddress = body.walletAddress && isAddress(body.walletAddress) ? body.walletAddress : null;
  const senderScope = merchantId === DEMO_TENANT ? (walletAddress ?? "__none__") : null;

  const { ask } = await import("@/lib/platform/assistant");
  return NextResponse.json(await ask(merchantId, question, { sender: senderScope }));
}
