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
import { decodeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { isOAuthConfigured } from "@/lib/auth/oauth";
import { isEmailAuthConfigured } from "@/lib/auth/email";

export async function GET(req: NextRequest) {
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({
    embedded: { providerId: "mera", label: "PayAI Wallet" },
    authMethods: {
      google: isOAuthConfigured("google"),
      apple: isOAuthConfigured("apple"),
      x: isOAuthConfigured("x"),
      email: isEmailAuthConfigured(),
    },
    session,
  });
}
