/**
 * OAuth callback for "Continue with Google / X". Exchanges the code, resolves
 * a deterministic userId ("<provider>:<sub>"), creates-or-recovers the
 * user's embedded wallet through the Wallet Service (never touches Mera
 * directly — see lib/wallet-service/registry.ts), opens a session, and
 * redirects into the dashboard exactly like a freshly connected external
 * wallet does today.
 *
 * Apple is intentionally NOT handled with the same code path: Apple posts
 * the callback as `application/x-www-form-urlencoded` (response_mode=
 * form_post) and needs a JWT client secret PayAI doesn't mint yet — see
 * lib/auth/oauth.ts. It 501s here rather than silently mishandling the
 * request.
 */
import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForUser } from "@/lib/auth/oauth";
import { encodeSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from "@/lib/auth/session";
import { getEmbeddedProvider } from "@/lib/wallet-service/registry";
import { recordWalletEvent } from "@/lib/platform/walletEvents";
import { DEMO_TENANT } from "@/lib/platform/merchants";
import type { AuthMethod } from "@/lib/wallet-service/types";

const STATE_COOKIE = "payai_oauth_state";

function siteUrl(req: NextRequest): string {
  return process.env.VERIPAYAI_PUBLIC_URL || req.nextUrl.origin;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const origin = siteUrl(req);

  if (provider === "apple") {
    return NextResponse.redirect(`${origin}/auth?error=apple_not_configured`);
  }
  if (provider !== "google" && provider !== "x") {
    return NextResponse.json({ error: `Unknown auth provider "${provider}".` }, { status: 404 });
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE)?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(`${origin}/auth?error=invalid_state`);
  }

  try {
    const redirectUri = `${origin}/api/auth/callback/${provider}`;
    const user = await exchangeCodeForUser(provider, { code, redirectUri });
    const userId = `${provider}:${user.sub}`;
    const authMethod = provider as AuthMethod;

    const embedded = getEmbeddedProvider();
    const wallet = await embedded.createOrRecoverWallet({ userId, authMethod });

    const session = { userId, authMethod, label: user.label, address: wallet.address, createdAt: Date.now() };
    const res = NextResponse.redirect(`${origin}/dashboard`);
    res.cookies.set(SESSION_COOKIE, encodeSession(session), SESSION_COOKIE_OPTS);
    res.cookies.delete(STATE_COOKIE);

    // "Created" fires once, on the real first login; every later sign-in is
    // a recovery, which is a connection — not a new wallet.
    await recordWalletEvent({
      merchantId: DEMO_TENANT,
      sender: wallet.address,
      providerId: embedded.id,
      ...(wallet.created
        ? {
            type: "wallet_created" as const,
            title: "Wallet created",
            detail: `Your PayAI Wallet was created and secured with your ${provider} sign-in.`,
          }
        : {
            type: "wallet_connected" as const,
            title: "Embedded wallet connected",
            detail: `Signed in with ${provider} and connected your PayAI Wallet.`,
          }),
    }).catch(() => {});

    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sign-in failed.";
    return NextResponse.redirect(`${origin}/auth?error=${encodeURIComponent(message)}`);
  }
}
