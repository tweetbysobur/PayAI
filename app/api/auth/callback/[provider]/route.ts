/**
 * OAuth callback for "Continue with Google / X".
 *
 * This establishes the PayAI ACCOUNT (who you are), not the wallet. The
 * wallet is derived in the browser from a passkey by the embedded provider
 * (see lib/wallet-service/providers/mera.ts) — its key material never
 * reaches this server, so there is nothing for a callback to create. The
 * client completes wallet setup immediately after this redirect, which is
 * what makes "sign in → wallet ready" a single continuous flow.
 *
 * Apple is intentionally NOT handled here: it posts its callback as
 * `application/x-www-form-urlencoded` (response_mode=form_post) and needs a
 * JWT client secret PayAI doesn't mint yet — see lib/auth/oauth.ts. It 501s
 * rather than silently mishandling the request.
 */
import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForUser } from "@/lib/auth/oauth";
import { encodeSession, SESSION_COOKIE, sessionCookieOpts } from "@/lib/auth/session";
import { APP_ORIGIN, cookieDomain, hostnameOf } from "@/lib/hosts";
import type { AuthMethod } from "@/lib/wallet-service/types";

const STATE_COOKIE = "payai_oauth_state";

function siteUrl(req: NextRequest): string {
  return process.env.VERIPAYAI_PUBLIC_URL || req.nextUrl.origin;
}

function afterAuthUrl(req: NextRequest, path: string): string {
  const h = hostnameOf(req.headers.get("host"));
  if (h === "usepayai.xyz" || h.endsWith(".usepayai.xyz")) return `${APP_ORIGIN}${path}`;
  return `${req.nextUrl.origin}${path}`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const origin = siteUrl(req);

  if (provider === "apple") {
    return NextResponse.redirect(`${afterAuthUrl(req, "/auth")}?error=apple_not_configured`);
  }
  if (provider !== "google" && provider !== "x") {
    return NextResponse.json({ error: `Unknown auth provider "${provider}".` }, { status: 404 });
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE)?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(`${afterAuthUrl(req, "/auth")}?error=invalid_state`);
  }

  try {
    const redirectUri = `${origin}/api/auth/callback/${provider}`;
    const user = await exchangeCodeForUser(provider, { code, redirectUri });

    const session = {
      userId: `${provider}:${user.sub}`,
      authMethod: provider as AuthMethod,
      label: user.label,
      createdAt: Date.now(),
    };
    // Back to onboarding rather than the dashboard: the account exists, but
    // the wallet still needs its one passkey step, which only the browser
    // can perform.
    const res = NextResponse.redirect(`${afterAuthUrl(req, "/auth")}?step=wallet`);
    const host = req.headers.get("host");
    res.cookies.set(SESSION_COOKIE, encodeSession(session), sessionCookieOpts(host));
    res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0, ...(cookieDomain(host) ? { domain: cookieDomain(host) } : {}) });
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sign-in failed.";
    return NextResponse.redirect(`${afterAuthUrl(req, "/auth")}?error=${encodeURIComponent(message)}`);
  }
}
