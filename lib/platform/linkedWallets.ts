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
  /** When this wallet was last seen connected. Lets the manager show "2 days
   *  ago" instead of implying every linked wallet is present right now — the
   *  link is a record, not a live connection. */
  lastConnectedAt?: number;
}

/**
 * Which wallet a given kind of work should use by default.
 *
 * PayAI must never silently switch the wallet a payment or an automation
 * spends from — the whole point of holding two is knowing which one is
 * moving. These are the user's stated defaults, stored per account, and the
 * automation form reads them rather than guessing from whatever happens to be
 * active when the form is opened.
 */
export interface WalletDefaults {
  /** Address to pay from, or null to follow whichever wallet is active. */
  payment: string | null;
  /** Address automations execute from. Deliberately separate: a recurring
   *  payment runs while nobody is watching, so it should not inherit a choice
   *  someone made for a one-off send weeks ago. */
  automation: string | null;
}

const key = (account: string) => `payai:linked:${account.toLowerCase()}`;
const defaultsKey = (account: string) => `payai:wallet-defaults:${account.toLowerCase()}`;

const g = globalThis as unknown as {
  __payaiLinkedWallets?: Map<string, LinkedWallet[]>;
  __payaiWalletDefaults?: Map<string, WalletDefaults>;
};
const mem = (g.__payaiLinkedWallets ??= new Map());
const memDefaults = (g.__payaiWalletDefaults ??= new Map());

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

/** Renames a linked wallet. The label is the user's own words — stored
 *  length-capped and never interpreted, only displayed. */
export async function renameLinkedWallet(
  account: string,
  external: string,
  label: string,
): Promise<LinkedWallet[] | null> {
  const address = external.toLowerCase();
  const list = await read(account);
  const row = list.find((w) => w.address.toLowerCase() === address);
  if (!row) return null;
  row.label = label;
  await write(account, list);
  return list;
}

/** Records that a linked wallet was seen connected just now. */
export async function touchLinkedWallet(account: string, external: string): Promise<void> {
  const address = external.toLowerCase();
  const list = await read(account);
  const row = list.find((w) => w.address.toLowerCase() === address);
  if (!row) return;
  row.lastConnectedAt = Date.now();
  await write(account, list);
}

export async function getWalletDefaults(account: string): Promise<WalletDefaults> {
  const r = await getRedis();
  const raw = r ? await r.get(defaultsKey(account)) : memDefaults.get(defaultsKey(account));
  if (!raw) return { payment: null, automation: null };
  try {
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<WalletDefaults>;
    return { payment: parsed.payment ?? null, automation: parsed.automation ?? null };
  } catch {
    return { payment: null, automation: null };
  }
}

/**
 * Sets a default. Only an address this account actually owns or has linked may
 * be named — otherwise a default could point at a wallet the account cannot
 * sign with, and every payment would fail at the last step with no explanation.
 */
export async function setWalletDefaults(
  account: string,
  next: Partial<WalletDefaults>,
): Promise<WalletDefaults | { error: string }> {
  const allowed = new Set<string>([account.toLowerCase()]);
  for (const w of await read(account)) allowed.add(w.address.toLowerCase());

  for (const [field, value] of Object.entries(next)) {
    if (value != null && !allowed.has(String(value).toLowerCase())) {
      return { error: `That wallet isn't linked to this account, so it can't be your default ${field} wallet.` };
    }
  }

  const current = await getWalletDefaults(account);
  const merged: WalletDefaults = {
    payment: next.payment !== undefined ? next.payment : current.payment,
    automation: next.automation !== undefined ? next.automation : current.automation,
  };
  const r = await getRedis();
  if (r) await r.set(defaultsKey(account), JSON.stringify(merged));
  else memDefaults.set(defaultsKey(account), merged);
  return merged;
}
