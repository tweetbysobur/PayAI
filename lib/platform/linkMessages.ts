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

/**
 * The message that authorises a wallet-settings change — a rename, or a new
 * default payment/automation wallet.
 *
 * It embeds the exact change being made, so a signature approving one edit
 * cannot be replayed to make a different one. Stringified from the same body
 * the server acts on, which is what keeps the two in step: if the request says
 * something the signature didn't cover, verification fails.
 */
export function walletSettingsMessage(account: string, body: unknown): string {
  const b = (body ?? {}) as {
    rename?: { external?: string; label?: string };
    defaults?: { payment?: string | null; automation?: string | null };
  };
  const lines = [
    "PayAI — update your wallet settings",
    `Account (PayAI Wallet): ${account.toLowerCase()}`,
  ];
  if (b.rename) {
    lines.push(`Rename ${String(b.rename.external ?? "").toLowerCase()} to: ${b.rename.label ?? ""}`);
  }
  if (b.defaults) {
    if (b.defaults.payment !== undefined) {
      lines.push(`Default payment wallet: ${b.defaults.payment ? String(b.defaults.payment).toLowerCase() : "whichever is active"}`);
    }
    if (b.defaults.automation !== undefined) {
      lines.push(`Default automation wallet: ${b.defaults.automation ? String(b.defaults.automation).toLowerCase() : "whichever is active"}`);
    }
  }
  lines.push("", "This changes settings only. It moves no funds.");
  return lines.join("\n");
}
