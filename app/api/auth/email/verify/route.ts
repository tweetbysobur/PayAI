/** Verifies the one-time code from POST /api/auth/email, then creates or
 *  recovers the embedded wallet and opens a session — same downstream path
 *  as the OAuth callback. */
import { NextRequest, NextResponse } from "next/server";
import { verifyEmailCode } from "@/lib/auth/email";
import { encodeSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/auth/session";
import { getEmbeddedProvider } from "@/lib/wallet-service/registry";
import { recordWalletEvent } from "@/lib/platform/walletEvents";
import { DEMO_TENANT } from "@/lib/platform/merchants";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email || !code) {
    return NextResponse.json({ error: "Email and code are required." }, { status: 400 });
  }

  const ok = await verifyEmailCode(email, code);
  if (!ok) {
    return NextResponse.json({ error: "That code is invalid or expired." }, { status: 401 });
  }

  const userId = `email:${email.toLowerCase()}`;
  const embedded = getEmbeddedProvider();
  const wallet = await embedded.createOrRecoverWallet({ userId, authMethod: "email" });

  const session = { userId, authMethod: "email" as const, label: email, address: wallet.address, createdAt: Date.now() };
  const res = NextResponse.json({ address: wallet.address });
  res.cookies.set(SESSION_COOKIE, encodeSession(session), SESSION_COOKIE_OPTS);

  await recordWalletEvent({
    merchantId: DEMO_TENANT,
    sender: wallet.address,
    type: "wallet_connected",
    providerId: embedded.id,
    title: "Embedded wallet connected",
    detail: "Signed in with email and connected your PayAI Wallet.",
  }).catch(() => {});

  return res;
}
