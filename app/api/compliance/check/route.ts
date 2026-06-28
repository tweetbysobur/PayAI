import { NextRequest, NextResponse } from "next/server";
import type { PaymentRequest } from "@/lib/verigate/types";
import { isAddress, resolvePayee } from "@/lib/payees/directory";
import { isDomainName, extractDomain } from "@/lib/monad/domain-resolver";

/**
 * POST /api/compliance/check — screen a single recipient (address or .nads
 * domain) on demand. This is its own endpoint, not the agent pipeline, because
 * "check compliance for 0x…" collides with the read-only check_compliance query
 * intent (which returns aggregate stats). Here we run the real VeriGate
 * screening + risk assessment against the resolved address and return the
 * per-address result.
 */
export async function POST(req: NextRequest) {
  let body: { recipient?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const input = body.recipient?.trim();
  if (!input) return NextResponse.json({ error: "A recipient is required." }, { status: 400 });

  // Resolve to a real address: .nads domain → payee name → raw 0x.
  let recipient = input;
  let domain: string | null = null;
  if (!isAddress(recipient)) {
    if (isDomainName(recipient)) {
      const { resolveDomain } = await import("@/lib/monad/domain-resolver");
      const dom = extractDomain(recipient) ?? recipient;
      const resolution = await resolveDomain(dom);
      if (!resolution.resolvedAddress) {
        return NextResponse.json({ error: `Couldn't resolve ${dom}.` }, { status: 422 });
      }
      domain = resolution.domain;
      recipient = resolution.resolvedAddress;
    } else {
      const payee = resolvePayee(recipient);
      if (!payee) return NextResponse.json({ error: `"${input}" isn't a valid address, .nads domain, or known payee.` }, { status: 422 });
      recipient = payee.address;
    }
  }

  const { runCompliance, assessRisk } = await import("@/lib/verigate/client");
  // A nominal request so screening + risk run against the address itself; the
  // amount is not what's being checked here, the counterparty is.
  const request: PaymentRequest = { action: "send_payment", amount: 1, token: "USDC", recipient, purpose: null, network: "monad" };
  const compliance = runCompliance(request);
  const risk = assessRisk(request);

  return NextResponse.json({
    recipient, domain,
    status: compliance.status,
    summary: compliance.summary,
    checks: compliance.checks,
    risk: { score: risk.score, level: risk.level },
  });
}
