/** Wallet-level notifications for the connected wallet (embedded or
 *  external) — wallet created/connected/disconnected, deposits, withdrawals.
 *  Same "scoped to your own address" rule as every other per-wallet feed. */
import { NextRequest, NextResponse } from "next/server";
import { listWalletEvents, recordWalletEvent } from "@/lib/platform/walletEvents";
import { resolveTenantId } from "@/lib/platform/tenant";
import { WALLET_EVENT_TYPES, type WalletEventType } from "@/lib/wallet-service/types";
import { reconcileWalletTransfers } from "@/lib/wallet-service/reconcile";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ events: [] });
  const merchantId = await resolveTenantId(req);

  // Catch up on-chain deposits/withdrawals before reading the feed, so a
  // transfer that landed while the user was away shows up the moment they
  // come back. Self-throttling (see reconcile.ts), so the 20s notification
  // poll triggers a real chain scan at most once a minute — and never fails
  // the request: a chain hiccup should degrade to "no new deposits", not to
  // an empty notification list.
  await reconcileWalletTransfers({
    merchantId,
    address: wallet,
    providerId: req.nextUrl.searchParams.get("provider") === "mera" ? "mera" : "injected",
  }).catch(() => {});

  const events = await listWalletEvents(merchantId, wallet);
  return NextResponse.json({ events });
}

/**
 * Client-driven wallet events — used for the "external" provider, whose
 * connect/disconnect happens entirely in the browser (EIP-1193), unlike
 * embedded sign-in which already records wallet_connected server-side in the
 * OAuth/email callback. Trusts the caller-supplied wallet address the same
 * way /api/agent already does for the wallet-scoped payment path — this is a
 * notification-only write, not a funds-moving one.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const sender = typeof body?.sender === "string" ? body.sender : "";
  const type = body?.type as WalletEventType;
  if (!sender || !WALLET_EVENT_TYPES.includes(type)) {
    return NextResponse.json({ error: "sender and a valid type are required." }, { status: 400 });
  }
  const merchantId = await resolveTenantId(req);
  const event = await recordWalletEvent({
    merchantId,
    sender,
    type,
    providerId: body?.providerId === "mera" ? "mera" : "injected",
    title: typeof body?.title === "string" ? body.title : type,
    detail: typeof body?.detail === "string" ? body.detail : "",
  });
  return NextResponse.json({ event });
}
