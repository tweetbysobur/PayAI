import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "@/lib/payees/directory";
import type { SupportCategory } from "@/lib/platform/types";

const CATEGORIES: SupportCategory[] = [
  "failed_automation", "missing_refund", "payment_issue",
  "wallet_issue", "bug_report", "feature_request", "general_question",
];

/**
 * GET /api/support?wallet=0x… — a wallet's own submitted tickets.
 * POST /api/support — submit a new ticket.
 *
 * Same wallet-scoping rule as every other read/write on the shared demo
 * tenant: a wallet resolves to a sentinel that matches nothing rather than
 * "show everyone's tickets."
 */
export async function GET(req: NextRequest) {
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  const { listTickets } = await import("@/lib/platform/support");

  const merchantId = await resolveTenantId(req);
  const w = new URL(req.url).searchParams.get("wallet")?.trim();
  const sender = merchantId === DEMO_TENANT ? (w && isAddress(w) ? w : "__none__") : null;
  const { denyPrivateRead } = await import("@/lib/auth/walletGrant");
  const denied = await denyPrivateRead(req, sender);
  if (denied) return denied;

  const tickets = await listTickets(merchantId, { sender });
  return NextResponse.json({ tickets });
}

export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: {
    walletAddress?: string; category?: string; description?: string;
    automationId?: string | null; txHash?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const category = body.category as SupportCategory;
  const description = body.description?.trim() ?? "";
  const walletAddress = body.walletAddress && isAddress(body.walletAddress) ? body.walletAddress : null;

  if (!CATEGORIES.includes(category)) return NextResponse.json({ error: "Choose a valid issue category." }, { status: 400 });
  if (!description) return NextResponse.json({ error: "Describe the issue." }, { status: 400 });
  if (description.length > 4000) return NextResponse.json({ error: "Description is too long (4000 characters max)." }, { status: 400 });

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { createTicket } = await import("@/lib/platform/support");
  const merchantId = await resolveTenantId(req);

  const ticket = await createTicket({
    merchantId,
    sender: walletAddress,
    category,
    description,
    automationId: body.automationId?.trim() || null,
    txHash: body.txHash?.trim() || null,
  });
  return NextResponse.json({ success: true, ticket });
}
