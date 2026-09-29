import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/links/route";

/**
 * A payment link pays whoever created it.
 *
 * On the shared (wallet-only) tenant there is no merchant record, and the
 * link used to take its recipient from VERIPAYAI_DEMO_PAYOUT_WALLET — a PayAI
 * wallet — even when the user creating the link from Dashboard → Invoices was
 * connected. The checkout page then asked the payer to send the money there,
 * under "No funds pass through us". With the variable unset the link could
 * not be paid at all ("hasn't connected a payout wallet").
 */
const CREATOR = "0x3333333333333333333333333333333333333333";
const DEMO_PAYOUT = "0x4444444444444444444444444444444444444444";

function post(body: unknown): NextRequest {
  return new NextRequest("https://usepayai.xyz/api/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/links on the shared tenant", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.VERIPAYAI_DEMO_PAYOUT_WALLET;
    const g = globalThis as unknown as { __veripayRL?: Map<string, unknown> };
    g.__veripayRL?.clear();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.VERIPAYAI_DEMO_PAYOUT_WALLET;
    else process.env.VERIPAYAI_DEMO_PAYOUT_WALLET = saved;
  });

  it("pays the connected creator, not the PayAI demo payout wallet", async () => {
    process.env.VERIPAYAI_DEMO_PAYOUT_WALLET = DEMO_PAYOUT;
    const res = await POST(post({ amount: 12, token: "USDC", walletAddress: CREATOR }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.link.recipient?.toLowerCase()).toBe(CREATOR.toLowerCase());
  });

  it("is payable when no demo payout wallet is configured", async () => {
    delete process.env.VERIPAYAI_DEMO_PAYOUT_WALLET;
    const res = await POST(post({ amount: 12, token: "USDC", walletAddress: CREATOR }));
    const body = await res.json();
    expect(body.link.recipient?.toLowerCase()).toBe(CREATOR.toLowerCase());
  });

  it("without a creator wallet, keeps the configured demo payout wallet", async () => {
    process.env.VERIPAYAI_DEMO_PAYOUT_WALLET = DEMO_PAYOUT;
    const res = await POST(post({ amount: 12, token: "USDC" }));
    const body = await res.json();
    expect(body.link.recipient).toBe(DEMO_PAYOUT);
  });
});
