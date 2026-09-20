/**
 * Starts a "Continue with Google / Apple / X" flow, or (POST, provider =
 * "email") sends a one-time email code. Every path is config-gated: with no
 * client id/secret set for a provider, this refuses with a clear
 * `configured: false` instead of starting a flow that can't finish.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { isOAuthConfigured, buildAuthorizeUrl, type OAuthProviderId } from "@/lib/auth/oauth";
import { isEmailAuthConfigured, sendEmailCode } from "@/lib/auth/email";
import { isSessionConfigured } from "@/lib/auth/session";
import { cookieDomain } from "@/lib/hosts";
import { rateLimited } from "@/lib/platform/ratelimit";

const OAUTH_PROVIDERS: OAuthProviderId[] = ["google", "apple", "x"];
const STATE_COOKIE = "payai_oauth_state";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function siteUrl(req: NextRequest): string {
  return process.env.VERIPAYAI_PUBLIC_URL || req.nextUrl.origin;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;

  if (provider === "email") {
    return NextResponse.json({ error: "Use POST /api/auth/email with { email } to request a code." }, { status: 405 });
  }

  if (!OAUTH_PROVIDERS.includes(provider as OAuthProviderId)) {
    return NextResponse.json({ error: `Unknown auth provider "${provider}".` }, { status: 404 });
  }
  const p = provider as OAuthProviderId;
  if (!isSessionConfigured()) {
    return NextResponse.json(
      { configured: false, error: "Social sign-in needs AUTH_SESSION_SECRET set on this deployment." },
      { status: 501 },
    );
  }
  if (!isOAuthConfigured(p)) {
    return NextResponse.json(
      { configured: false, error: `Continue with ${p} isn't set up on this deployment yet.` },
      { status: 501 },
    );
  }

  const state = randomBytes(16).toString("hex");
  const redirectUri = `${siteUrl(req)}/api/auth/callback/${p}`;
  const authorizeUrl = buildAuthorizeUrl(p, { redirectUri, state });

  const res = NextResponse.redirect(authorizeUrl);
  const domain = cookieDomain(req.headers.get("host"));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
    ...(domain ? { domain } : {}),
  });
  return res;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (provider !== "email") {
    return NextResponse.json({ error: "POST is only used for email sign-in." }, { status: 405 });
  }
  if (!isSessionConfigured() || !isEmailAuthConfigured()) {
    return NextResponse.json({ configured: false, error: "Continue with email isn't set up on this deployment yet." }, { status: 501 });
  }
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
  }

  // Two limiters, both required: per-IP stops one host enumerating addresses,
  // per-address stops a rotating-IP attacker flooding one person's inbox
  // (each send costs real money and lands in a stranger's mail).
  const ipLimited = await rateLimited(req, "auth-email-ip", { max: 5, windowSec: 300 });
  if (ipLimited) return ipLimited;
  const addressLimited = await rateLimited(req, "auth-email-addr", { max: 3, windowSec: 300, subject: email });
  if (addressLimited) return addressLimited;

  try {
    await sendEmailCode(email);
    return NextResponse.json({ sent: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not send the code." }, { status: 500 });
  }
}
