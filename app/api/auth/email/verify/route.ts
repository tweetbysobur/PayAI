/** Verifies the one-time code from POST /api/auth/email and opens a PayAI
 *  account session. Like the OAuth callback, this establishes identity only —
 *  the wallet is derived in the browser from a passkey, so no wallet is (or
 *  can be) created here. */
import { NextRequest, NextResponse } from "next/server";
import { verifyEmailCode } from "@/lib/auth/email";
import { encodeSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/auth/session";
import { rateLimited } from "@/lib/platform/ratelimit";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email || !code) {
    return NextResponse.json({ error: "Email and code are required." }, { status: 400 });
  }

  // Defence in depth over the per-code attempt cap in verifyEmailCode: that
  // cap burns one code after 5 guesses, this stops an attacker cheaply
  // requesting a fresh code and spending 5 more guesses, over and over.
  const limited = await rateLimited(req, "auth-email-verify", { max: 10, windowSec: 300, subject: email });
  if (limited) return limited;

  const ok = await verifyEmailCode(email, code);
  if (!ok) {
    return NextResponse.json({ error: "That code is invalid or expired." }, { status: 401 });
  }

  const session = {
    userId: `email:${email.toLowerCase()}`,
    authMethod: "email" as const,
    label: email,
    createdAt: Date.now(),
  };
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, encodeSession(session), SESSION_COOKIE_OPTS);
  return res;
}
