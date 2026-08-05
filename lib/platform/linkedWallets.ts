/**
 * Wallets linked to a PayAI account.
 *
 * A PayAI Wallet is the account: passkey-derived, the thing a user signs in
 * as. An external wallet (MetaMask, Rabby, a hardware wallet) can be attached
 * to it, so both live side by side and the user moves between them instead of
 * one silently replacing the other.
 *
 * **Both ends have to prove themselves.** Linking takes two signatures over
 * the same message: one from the external wallet, proving the person holds
 * it, and one from the PayAI Wallet, proving they meant to attach it to *this*
 * account. Requiring only the external signature would let anyone attach a
 * wallet they control to a stranger's account — an address is public, so the
 * attacker needs nothing but the victim's. A wallet appearing under "your
 * wallets" that isn't yours is exactly the setup for "just send it to your
 * linked wallet", so this is not a formality.
 *
 * The link is a convenience record, not custody. It grants nothing: neither
 * wallet can spend from the other, and PayAI cannot spend from either. Losing
 * the record costs a re-link and nothing else.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";

// The signed messages live in a shared module so the browser (which produces
// the signatures) and this server code (which verifies them) can never drift.
export { linkMessage, unlinkMessage } from "./linkMessages";

/** Enough for a hardware wallet, a hot wallet and a spare, without turning
 *  the switcher into a list nobody can scan. */
export const MAX_LINKED_WALLETS = 5;

export interface LinkedWallet {
  /** The external wallet's address. */
  address: string;
  /** What the user calls it. Their words, length-capped, never interpreted. */
  label: string;
  linkedAt: number;
}

const key = (account: string) => `payai:linked:${account.toLowerCase()}`;

const g = globalThis as unknown as { __payaiLinkedWallets?: Map<string, LinkedWallet[]> };
const mem = (g.__payaiLinkedWallets ??= new Map());

async function read(account: string): Promise<LinkedWallet[]> {
  const r = await getRedis();
  const raw = r ? await r.get(key(account)) : mem.get(key(account));
  if (!raw) return [];
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? (list as LinkedWallet[]) : [];
  } catch {
    return [];
  }
}

async function write(account: string, list: LinkedWallet[]): Promise<void> {
  const r = await getRedis();
  if (r) await r.set(key(account), JSON.stringify(list));
  else mem.set(key(account), list);
}

export async function listLinkedWallets(account: string): Promise<LinkedWallet[]> {
  return (await read(account)).sort((a, b) => a.linkedAt - b.linkedAt);
}

export type LinkOutcome =
  | { ok: true; wallets: LinkedWallet[]; alreadyLinked: boolean }
  | { ok: false; error: string };

export async function linkWallet(
  account: string,
  external: string,
  label: string,
): Promise<LinkOutcome> {
  const address = external.toLowerCase();
  if (address === account.toLowerCase()) {
    return { ok: false, error: "That's this account's own wallet — there's nothing to link." };
  }

  const list = await read(account);
  const existing = list.find((w) => w.address.toLowerCase() === address);
  if (existing) {
    // Re-linking an already-linked wallet is how a label gets changed, and it
    // has to stay a no-op otherwise: a retried request must not add a second
    // row for the same wallet.
    existing.label = label || existing.label;
    await write(account, list);
    return { ok: true, wallets: list, alreadyLinked: true };
  }
  if (list.length >= MAX_LINKED_WALLETS) {
    return { ok: false, error: `You can link up to ${MAX_LINKED_WALLETS} wallets. Remove one first.` };
  }

  list.push({ address, label, linkedAt: Date.now() });
  await write(account, list);
  return { ok: true, wallets: list, alreadyLinked: false };
}

export async function unlinkWallet(account: string, external: string): Promise<LinkedWallet[]> {
  const address = external.toLowerCase();
  const list = (await read(account)).filter((w) => w.address.toLowerCase() !== address);
  await write(account, list);
  return list;
}
