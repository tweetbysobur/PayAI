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
 * Client-driven wallet events — the wallet lifecycle only.
 *
 * Connect/disconnect/create happen entirely in the browser (EIP-1193 for an
 * external wallet, a passkey ceremony for an embedded one), so the client is
 * the only thing that can report them. That is the whole reason this endpoint
 * exists, and the reason it is narrow.
 *
 * It deliberately CANNOT post money events. It used to accept any of the
 * WALLET_EVENT_TYPES with a caller-supplied title and detail, which meant
 * anyone who knew someone's address — a public value, visible on any
 * explorer — could push "Deposit received · 500 MON arrived" into their feed
 * and raise the deposit alert on their screen. Money events are reported by
 * the server-side reconciler in lib/wallet-service/reconcile.ts, from
 * verified on-chain movement, and by nothing else.
 *
 * Wording is server-owned for the same reason: a lifecycle event has exactly
 * one thing it can say, so there is no free text to put words in PayAI's
 * mouth.
 */
const CLIENT_REPORTABLE = {
  wallet_created: {
    mera: { title: "Wallet created", detail: "Your PayAI Wallet was created and secured with your passkey." },
    injected: { title: "Wallet created", detail: "A new wallet was added to PayAI." },
  },
  wallet_connected: {
    mera: { title: "Wallet unlocked", detail: "You unlocked your PayAI Wallet with your passkey." },
    injected: { title: "External wallet connected", detail: "Connected an external wallet to PayAI." },
  },
  wallet_disconnected: {
    mera: { title: "Wallet locked", detail: "You signed out of your PayAI Wallet." },
    injected: { title: "External wallet disconnected", detail: "Disconnected your external wallet from PayAI." },
  },
} as const satisfies Partial<Record<WalletEventType, Record<"mera" | "injected", { title: string; detail: string }>>>;

export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "wallet-events", { max: 20, windowSec: 60 });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const sender = typeof body?.sender === "string" ? body.sender.trim() : "";
  const type = body?.type as WalletEventType;
  if (!/^0x[0-9a-fA-F]{40}$/.test(sender)) {
    return NextResponse.json({ error: "A valid wallet address is required." }, { status: 400 });
  }
  if (!WALLET_EVENT_TYPES.includes(type) || !(type in CLIENT_REPORTABLE)) {
    return NextResponse.json(
      { error: "Only wallet lifecycle events can be reported by a client." },
      { status: 400 },
    );
  }

  const merchantId = await resolveTenantId(req);
  const providerId = body?.providerId === "mera" ? "mera" : "injected";
  const copy = CLIENT_REPORTABLE[type as keyof typeof CLIENT_REPORTABLE][providerId];
  const event = await recordWalletEvent({
    merchantId,
    sender,
    type,
    providerId,
    title: copy.title,
    detail: copy.detail,
  });
  return NextResponse.json({ event });
}
