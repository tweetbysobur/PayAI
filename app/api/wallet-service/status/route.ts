/**
 * Which sign-in methods this deployment has configured, plus the current
 * account session.
 *
 * Deliberately says nothing about whether the embedded wallet is "available":
 * with Mera that's a property of the user's BROWSER (passkey + WebAuthn PRF
 * support), not of server configuration, so only the client can answer it —
 * see getEmbeddedProvider().isSupported().
 */
import { NextRequest, NextResponse } from "next/server";
import { decodeSession, isSessionConfigured, SESSION_COOKIE } from "@/lib/auth/session";
import { isOAuthConfigured } from "@/lib/auth/oauth";
import { isEmailAuthConfigured } from "@/lib/auth/email";
import { getAccountWallet } from "@/lib/platform/accountWallet";

export async function GET(req: NextRequest) {
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  const accountWallet = session ? await getAccountWallet(session.userId).catch(() => null) : null;
  // Every social/email method also needs a signing secret for the account
  // cookie. Without it they'd fail at the last step, after the user had
  // already left for Google — so they're reported unavailable up front.
  // The passkey wallet is unaffected: it needs no server session at all.
  const sessions = isSessionConfigured();
  return NextResponse.json({
    embedded: { providerId: "mera", label: "PayAI Wallet" },
    authMethods: {
      google: sessions && isOAuthConfigured("google"),
      apple: sessions && isOAuthConfigured("apple"),
      x: sessions && isOAuthConfigured("x"),
      email: sessions && isEmailAuthConfigured(),
    },
    session,
    accountWallet,
  });
}
