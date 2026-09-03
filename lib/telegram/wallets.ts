/**
 * Per-Telegram-user custodial wallets for the trading bot.
 *
 * Each Telegram user gets exactly one Monad EVM keypair, generated the
 * first time they run /start and never regenerated after — the address is
 * a deposit target, so silently issuing a second key for the same user
 * would orphan any funds already sent to the first one. That "never
 * regenerated" guarantee is the one property this module exists to protect,
 * and it has to hold even when two /start requests for a brand-new user
 * race each other (a Telegram retry, a double-tap): see
 * getOrCreateTelegramWallet's own doc for how the atomic claim below makes
 * that safe.
 *
 * The private key itself is never returned from this module in the clear
 * except from getTelegramWalletAccount(), which exists ONLY for the two
 * places that actually need to sign (lib/telegram/tradeRunner.ts and
 * lib/telegram/executeTransfer.ts) — command handlers that merely display
 * wallet info should use getOrCreateTelegramWallet()'s public-only return.
 *
 * KV-backed (Upstash Redis) with an in-memory fallback, matching
 * lib/platform/merchants.ts and lib/platform/idempotency.ts's own
 * precedent for this pattern.
 *
 * Server-only.
 */
import "server-only";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getRedis } from "@/lib/platform/kv";
import { encryptWalletKey, decryptWalletKey, type EncryptedKeyRecord } from "./walletCrypto";

interface StoredWalletRecord extends EncryptedKeyRecord {
  address: string;
  createdAt: number;
}

export interface TelegramWalletPublic {
  address: string;
  createdAt: number;
}

function storageKey(telegramUserId: string): string {
  return `veripay:telegram:wallet:${telegramUserId}`;
}

function toPublic(r: StoredWalletRecord): TelegramWalletPublic {
  return { address: r.address, createdAt: r.createdAt };
}

function generateRecord(): StoredWalletRecord {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return { address, createdAt: Date.now(), ...encryptWalletKey(privateKey) };
}

const g = globalThis as unknown as { __veripayTelegramWallets?: Map<string, StoredWalletRecord> };
const mem = (g.__veripayTelegramWallets ??= new Map());

/**
 * Returns the existing wallet for this Telegram user, or generates and
 * stores a brand-new one on first use. Idempotent under concurrency: two
 * simultaneous calls for a user with no wallet yet must not both win and
 * store two different keys under the same slot — the second write would
 * silently strand anything already sent to the first address. Uses the
 * same SET-NX atomic-claim idiom as lib/platform/idempotency.ts's
 * claimRequest() rather than a get-then-set (which has a race window
 * between the two round trips): the loser of the race discards its own
 * freshly generated (never persisted) key and reads back whichever record
 * actually won.
 *
 * No TTL on the stored record, unlike the idempotency precedent this
 * pattern is borrowed from — a wallet has to persist indefinitely, not
 * expire after a claim window.
 */
export async function getOrCreateTelegramWallet(telegramUserId: string): Promise<TelegramWalletPublic> {
  const key = storageKey(telegramUserId);
  const r = await getRedis();
  if (r) {
    const existing = (await r.get(key)) as StoredWalletRecord | null;
    if (existing) return toPublic(existing);

    const candidate = generateRecord();
    const claimed = await r.set(key, candidate, { nx: true });
    if (claimed) return toPublic(candidate);

    // Lost the race to a concurrent /start — read back the winner rather
    // than trusting our own discarded candidate. If it vanished in the gap
    // (should not happen: no TTL), fall back to trying our own candidate's
    // public info rather than throwing, matching claimRequest()'s "treat a
    // vanished record as free" precedent.
    const winner = (await r.get(key)) as StoredWalletRecord | null;
    return toPublic(winner ?? candidate);
  }

  const existingMem = mem.get(key);
  if (existingMem) return toPublic(existingMem);
  const created = generateRecord();
  mem.set(key, created);
  return toPublic(created);
}

/**
 * Decrypts and returns the signing account for a Telegram user's wallet, or
 * null if they've never run /start. Internal use only — tradeRunner.ts and
 * executeTransfer.ts are the only callers that should ever hold a decrypted
 * key, and only for the duration of the one request that needs to sign.
 */
export async function getTelegramWalletAccount(telegramUserId: string): Promise<PrivateKeyAccount | null> {
  const key = storageKey(telegramUserId);
  const r = await getRedis();
  const record = r ? ((await r.get(key)) as StoredWalletRecord | null) : (mem.get(key) ?? null);
  if (!record) return null;
  const privateKey = decryptWalletKey(record) as `0x${string}`;
  return privateKeyToAccount(privateKey);
}
