/**
 * The messages a user signs to attach or detach a wallet.
 *
 * Shared by the browser (which produces the signatures) and the server (which
 * verifies them), so the two can never drift — a mismatch of one character
 * would make every link fail verification with nothing to show why.
 *
 * Deliberately readable: someone approving this in MetaMask should be able to
 * tell exactly what they are agreeing to, and that it is not an approval to
 * spend anything.
 */

/**
 * Names both addresses, so a signature captured from one link attempt cannot
 * be replayed to attach the wallet to a different account.
 */
export function linkMessage(account: string, external: string): string {
  return [
    "PayAI — link a wallet to your account",
    `Account (PayAI Wallet): ${account.toLowerCase()}`,
    `Wallet to link: ${external.toLowerCase()}`,
    "",
    "Signing this only links the two for your own convenience.",
    "It does not let either wallet spend from the other.",
  ].join("\n");
}

/** Separate wording from `linkMessage`, so an unlink signature can never be
 *  replayed as a link, or the other way round. */
export function unlinkMessage(account: string, external: string): string {
  return [
    "PayAI — unlink a wallet from your account",
    `Account (PayAI Wallet): ${account.toLowerCase()}`,
    `Wallet to unlink: ${external.toLowerCase()}`,
  ].join("\n");
}
