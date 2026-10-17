/**
 * OAuth2 provider configuration for "Continue with Google/Apple/X".
 *
 * Real, standard authorization-code endpoints — not placeholders — so the
 * flow works the moment a client id/secret is set in the deploy host's env,
 * with zero code changes. Until then, `isConfigured()` is false and the
 * caller (app/api/auth/[provider]/route.ts) refuses cleanly instead of
 * starting a flow that can't finish — same "configured vs not" convention as
 * lib/monad/wallet.ts and the Mera adapter.
 *
 * Apple's real flow additionally needs a JWT client-secret minted from
 * APPLE_PRIVATE_KEY/APPLE_KEY_ID/APPLE_TEAM_ID (not a static secret) and
 * responds via form_post — flagged inline below since it can't share the
 * generic token-exchange helper without that extra step.
 *
 * Server-only.
 */
import "server-only";

export type OAuthProviderId = "google" | "apple" | "x";

export interface OAuthUserInfo {
  /** Provider-scoped account id — combined with the provider id to form the
   *  PayAI account id. The wallet address is not derived from this. */
  sub: string;
  label: string;
}

interface OAuthProviderConfig {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  userInfoUrl?: string;
  parseUserInfo: (json: Record<string, unknown>) => OAuthUserInfo;
}

const CONFIG: Record<OAuthProviderId, OAuthProviderConfig> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    parseUserInfo: (j) => ({ sub: String(j.sub), label: String(j.email ?? j.sub) }),
  },
  x: {
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    scope: "tweet.read users.read offline.access",
    clientIdEnv: "X_CLIENT_ID",
    clientSecretEnv: "X_CLIENT_SECRET",
    userInfoUrl: "https://api.twitter.com/2/users/me",
    parseUserInfo: (j) => {
      const data = (j.data ?? j) as Record<string, unknown>;
      return { sub: String(data.id), label: `@${String(data.username ?? data.id)}` };
    },
  },
  apple: {
    authUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    scope: "name email",
    clientIdEnv: "APPLE_CLIENT_ID",
    // Apple has no static client secret — it's a short-lived JWT signed with
    // APPLE_PRIVATE_KEY/APPLE_KEY_ID/APPLE_TEAM_ID, minted per token request.
    clientSecretEnv: "APPLE_PRIVATE_KEY",
    parseUserInfo: (j) => ({ sub: String(j.sub), label: String(j.email ?? j.sub) }),
  },
};

export function oauthConfig(provider: OAuthProviderId): OAuthProviderConfig {
  return CONFIG[provider];
}

export function isOAuthConfigured(provider: OAuthProviderId): boolean {
  const cfg = CONFIG[provider];
  return !!process.env[cfg.clientIdEnv]?.trim() && !!process.env[cfg.clientSecretEnv]?.trim();
}

export function buildAuthorizeUrl(provider: OAuthProviderId, opts: { redirectUri: string; state: string; prompt?: string }): string {
  const cfg = CONFIG[provider];
  const clientId = process.env[cfg.clientIdEnv];
  if (!clientId) throw new Error(`${provider} sign-in is not configured (missing ${cfg.clientIdEnv}).`);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: cfg.scope,
    state: opts.state,
  });
  if (provider === "apple") params.set("response_mode", "form_post");
  if (opts.prompt) params.set("prompt", opts.prompt);
  return `${cfg.authUrl}?${params.toString()}`;
}

/** Exchanges an authorization code for a user identity. Google/X share this
 *  path; Apple needs its client secret minted as a JWT first (TODO once
 *  APPLE_KEY_ID/APPLE_TEAM_ID are wired in) so it's excluded here to avoid
 *  pretending a static secret works. */
export async function exchangeCodeForUser(
  provider: Exclude<OAuthProviderId, "apple">,
  opts: { code: string; redirectUri: string },
): Promise<OAuthUserInfo> {
  const cfg = CONFIG[provider];
  const clientId = process.env[cfg.clientIdEnv];
  const clientSecret = process.env[cfg.clientSecretEnv];
  if (!clientId || !clientSecret) throw new Error(`${provider} sign-in is not configured.`);

  const tokenRes = await fetch(cfg.tokenUrl, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw new Error(`${provider} token exchange failed (${tokenRes.status}).`);
  const tokenJson = (await tokenRes.json()) as { access_token: string };

  if (!cfg.userInfoUrl) throw new Error(`${provider} has no userinfo endpoint configured.`);
  const infoRes = await fetch(cfg.userInfoUrl, {
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!infoRes.ok) throw new Error(`${provider} userinfo request failed (${infoRes.status}).`);
  const infoJson = (await infoRes.json()) as Record<string, unknown>;
  return cfg.parseUserInfo(infoJson);
}
