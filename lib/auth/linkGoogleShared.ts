/**
 * The exact strings a passkey signs to attach or remove Google.
 * The server verifies these and will not bind a Gmail account to a wallet
 * without one. Linking does not create a wallet and does not move one.
 */

export const GOOGLE_LINK_COOKIE = "payai_oauth_link";
export const GOOGLE_LINK_TTL_MS = 10 * 60 * 1000;

export function linkGoogleMessage(address: string, credentialId: string, expiresAt: number): string {
  return [
    "PayAI link Google",
    `Address: ${address.toLowerCase()}`,
    `Passkey: ${credentialId}`,
    `Expires: ${expiresAt}`,
    "This connects a Google account to this wallet. It does not create a new wallet or change this address.",
  ].join("\n");
}

export function unlinkGoogleMessage(address: string, expiresAt: number): string {
  return [
    "PayAI unlink Google",
    `Address: ${address.toLowerCase()}`,
    `Expires: ${expiresAt}`,
    "Google will no longer open this wallet. The passkey and the wallet stay as they are.",
  ].join("\n");
}

/** A Google sign-in may open a wallet. It may not point that sign-in at a
 *  different one than the passkey it was linked to. */
export function openedWalletMatchesAccount(serverAddress: string | null | undefined, opened: string): boolean {
  if (!serverAddress) return true;
  return serverAddress.toLowerCase() === opened.toLowerCase();
}

export type GoogleLinkDecision = "link" | "google-taken" | "wallet-taken";

export function decideGoogleLink(input: {
  googleUserId: string;
  walletAddress: string;
  existingForGoogle: { address: string } | null;
  existingForWallet: { userId: string } | null;
}): GoogleLinkDecision {
  const address = input.walletAddress.toLowerCase();
  if (input.existingForGoogle && input.existingForGoogle.address.toLowerCase() !== address) return "google-taken";
  if (input.existingForWallet && input.existingForWallet.userId !== input.googleUserId) return "wallet-taken";
  return "link";
}
