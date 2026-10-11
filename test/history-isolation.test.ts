import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { grantCookieFor } from "./walletGrantCookie";

/** Each connected wallet sees only its own transaction history; with no
 *  wallet, or without that wallet's grant, nothing comes back. */
const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const B = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("KV_REST_API_TOKEN", "");
  vi.stubEnv("AUTH_SESSION_SECRET", "test-only-session-secret");
  (globalThis as { __veripayMem?: Map<string, unknown> }).__veripayMem?.clear();
});

async function history(walletAddress: string | null, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/agent/route");
  const res = await POST(new NextRequest("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.1`, ...headers },
    body: JSON.stringify({ intent: "Show my transaction history", walletAddress }),
  }));
  return { status: res.status, body: (await res.json()) as { history?: { sender?: string }[] } };
}

describe("transaction history is per wallet", () => {
  it("each wallet sees only its own rows", async () => {
    const { recordTx } = await import("@/lib/platform/store");
    const { DEMO_TENANT } = await import("@/lib/platform/merchants");
    for (const [sender, amount] of [[A, 1], [A, 2], [B, 3]] as const) {
      await recordTx(DEMO_TENANT, { decision: "executed", action: "send_payment", feature: "payment", amount, token: "USDC", recipient: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", sender, riskScore: 0, compliance: "passed", summary: "x" });
    }
    const a = await history(A, grantCookieFor(A));
    const b = await history(B, grantCookieFor(B));
    expect(a.body.history).toHaveLength(2);
    expect(a.body.history!.every((h) => h.sender?.toLowerCase() === A.toLowerCase())).toBe(true);
    expect(b.body.history).toHaveLength(1);
    expect(b.body.history![0].sender?.toLowerCase()).toBe(B.toLowerCase());
  });

  it("no wallet → empty; another wallet's address without its grant → refused", async () => {
    const { recordTx } = await import("@/lib/platform/store");
    const { DEMO_TENANT } = await import("@/lib/platform/merchants");
    await recordTx(DEMO_TENANT, { decision: "executed", action: "send_payment", feature: "payment", amount: 1, token: "USDC", recipient: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", sender: A, riskScore: 0, compliance: "passed", summary: "x" });
    expect((await history(null)).body.history).toHaveLength(0);
    const snoop = await history(A, grantCookieFor(B));
    expect(snoop.status).toBe(401);
    expect(snoop.body.history).toEqual([]);
  });
});
