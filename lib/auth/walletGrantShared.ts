/**
 * The message a wallet signs to read its own PayAI data.
 *
 * A wallet address is public. It must not be enough to read automations,
 * payment memos, support tickets, or history. This signature is the proof
 * the caller holds the key. The server turns a valid one into an httpOnly
 * cookie; the signature itself is not reused as a credential.
 *
 * Shared by the browser (it signs this exact string) and the server (it
 * verifies that same string). No secrets live here.
 */

export const WALLET_GRANT_COOKIE = "payai_wallet_grant";
/** How long a successful unlock keeps read access. The passkey is not
 *  required again on every page load inside this window. */
export const WALLET_GRANT_TTL_MS = 12 * 60 * 60 * 1000;

export function walletGrantMessage(address: string, expiresAt: number): string {
  return [
    "PayAI wallet access",
    `Address: ${address.toLowerCase()}`,
    `Expires: ${expiresAt}`,
    "This only lets this browser read your PayAI data. It cannot move funds.",
  ].join("\n");
}
