import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/wallet-events/route";
import { listWalletEvents } from "@/lib/platform/walletEvents";

/**
 * A client may report that a wallet connected. It may not report that money
 * arrived.
 *
 * This endpoint exists because wallet connect/disconnect happens entirely in
 * the browser, so nothing else can observe it. It used to accept any of the
 * wallet event types with a caller-supplied title and detail — including
 * `deposit_received`. A wallet address is public, visible on any explorer, so
 * that meant anyone who knew someone's address could push
 * "Deposit received · 500 MON arrived" into their notification feed, and (since
 * deposits get their own interrupting alert) onto their screen. Convincing
 * someone money has landed is the opening move of most payment scams.
 *
 * Money events come from lib/wallet-service/reconcile.ts, which reads them off
 * the chain, and from nowhere else.
 */
const VICTIM = "0x1111111111111111111111111111111111111111";

function post(body: unknown): NextRequest {
  return new NextRequest("https://usepayai.xyz/api/wallet-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/wallet-events", () => {
  beforeEach(() => {
    // Each test gets a fresh rate-limit window and event list.
    const g = globalThis as unknown as { __payaiWalletEvents?: Map<string, unknown>; __veripayRL?: Map<string, unknown> };
    g.__payaiWalletEvents?.clear();
    g.__veripayRL?.clear();
  });

  it("refuses a client-reported deposit", async () => {
    const res = await POST(post({
      sender: VICTIM,
      type: "deposit_received",
      title: "Deposit received",
      detail: "500 MON arrived in your wallet.",
    }));

    expect(res.status).toBe(400);
    expect(await listWalletEvents("demo", VICTIM), "no fabricated deposit may reach the feed").toHaveLength(0);
  });

  it("refuses a client-reported withdrawal", async () => {
    const res = await POST(post({ sender: VICTIM, type: "withdrawal_completed", title: "Withdrawal completed", detail: "All your MON left." }));
    expect(res.status).toBe(400);
    expect(await listWalletEvents("demo", VICTIM)).toHaveLength(0);
  });

  it("refuses a client-reported automation execution", async () => {
    const res = await POST(post({ sender: VICTIM, type: "automation_executed", title: "Automation executed" }));
    expect(res.status).toBe(400);
    expect(await listWalletEvents("demo", VICTIM)).toHaveLength(0);
  });

  it("accepts the wallet lifecycle events it exists to carry", async () => {
    for (const type of ["wallet_created", "wallet_connected", "wallet_disconnected"]) {
      const res = await POST(post({ sender: VICTIM, type, providerId: "mera" }));
      expect(res.status, `${type} must still work`).toBe(200);
    }
    expect(await listWalletEvents("demo", VICTIM)).toHaveLength(3);
  });

  it("writes its own wording, never the caller's", async () => {
    // Free text in a notification is PayAI speaking. A caller that can choose
    // the words can say anything under PayAI's name, even on an event type
    // that is otherwise harmless.
    await POST(post({
      sender: VICTIM,
      type: "wallet_connected",
      providerId: "mera",
      title: "Security alert: verify your wallet",
      detail: "Visit payai-verify.example to keep your funds safe.",
    }));

    const [event] = await listWalletEvents("demo", VICTIM);
    expect(event.title).not.toMatch(/Security alert/);
    expect(event.detail).not.toMatch(/example/);
    expect(event.title).toBe("Wallet unlocked");
  });

  it("rejects anything that isn't a wallet address", async () => {
    const res = await POST(post({ sender: "not-an-address", type: "wallet_connected" }));
    expect(res.status).toBe(400);
  });
});
