import { encodeWalletGrant, WALLET_GRANT_COOKIE } from "@/lib/auth/walletGrant";

/**
 * The Cookie header a browser holds after proving control of `address`: a
 * real grant signed by lib/auth/walletGrant.ts (with AUTH_SESSION_SECRET, or
 * its dev-only fallback outside production). Route tests use it for the
 * legitimate caller of a wallet — /api/agent approvals and
 * /api/agent/confirm require it. Empty for anything that isn't an address.
 */
export function grantCookieFor(address: unknown): Record<string, string> {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return {};
  return { cookie: `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(address, Date.now() + 60 * 60 * 1000)}` };
}
