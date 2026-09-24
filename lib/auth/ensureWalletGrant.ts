/**
 * Makes sure this browser holds a read grant for `address` before private
 * PayAI data is requested. If a valid cookie is already there, this does
 * not ask the wallet to sign again.
 */
import { WALLET_GRANT_TTL_MS, walletGrantMessage } from "./walletGrantShared";

let inflight: Promise<boolean> | null = null;
let inflightFor: string | null = null;

export async function ensureWalletGrant(
  address: string,
  sign: (message: string) => Promise<string>,
): Promise<boolean> {
  const key = address.toLowerCase();
  if (inflight && inflightFor === key) return inflight;
  inflightFor = key;
  inflight = (async () => {
    try {
      const current = await fetch("/api/auth/wallet-grant").then((r) => r.json()).catch(() => null);
      if (typeof current?.address === "string" && current.address.toLowerCase() === key) return true;
      const expiresAt = Date.now() + WALLET_GRANT_TTL_MS;
      const signature = await sign(walletGrantMessage(address, expiresAt));
      const res = await fetch("/api/auth/wallet-grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, expiresAt, signature }),
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      inflight = null;
      inflightFor = null;
    }
  })();
  return inflight;
}

export function clearWalletGrant(): void {
  fetch("/api/auth/wallet-grant", { method: "DELETE" }).catch(() => {});
}
