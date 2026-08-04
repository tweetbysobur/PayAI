/**
 * Public capability probe: is an embedded provider available right now, and
 * is there a signed-in embedded session? The client uses this to decide
 * whether to offer "Use PayAI Wallet (Embedded)" at all, instead of
 * hardcoding Mera's name or availability anywhere in components.
 */
import { NextRequest, NextResponse } from "next/server";
import { getEmbeddedProvider } from "@/lib/wallet-service/registry";
import { decodeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { isOAuthConfigured } from "@/lib/auth/oauth";
import { isEmailAuthConfigured } from "@/lib/auth/email";

export async function GET(req: NextRequest) {
  const embedded = getEmbeddedProvider();
  const available = await embedded.isAvailable();
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({
    embedded: { providerId: embedded.id, label: embedded.label, available },
    authMethods: {
      google: isOAuthConfigured("google"),
      apple: isOAuthConfigured("apple"),
      x: isOAuthConfigured("x"),
      email: isEmailAuthConfigured(),
    },
    session,
  });
}
