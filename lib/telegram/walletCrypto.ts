/**
 * Envelope encryption for the Telegram trading bot's per-user wallet keys.
 *
 * This is the only place in the app that persists a private key it generated
 * itself rather than reading one once from env (`MONAD_AGENT_PRIVATE_KEY` in
 * lib/monad/wallet.ts) — a Telegram user's hot wallet has to be recoverable
 * across requests, so the key has to live somewhere between "generated" and
 * "used to sign the next trade". Storing it in plaintext in Redis (or the
 * in-memory fallback) would mean anyone who can read that store — a KV
 * dashboard, a backup, a misconfigured log — can drain every wallet the bot
 * holds. AES-256-GCM keeps the key unreadable at rest AND tamper-evident: a
 * flipped byte in storage fails decryption outright (the auth tag check),
 * rather than silently handing back a corrupted key that then signs garbage.
 *
 * The master key (TELEGRAM_WALLET_MASTER_KEY, 32 raw bytes, base64-encoded
 * in env) never touches storage — only Vercel's env holds it, same posture
 * as MONAD_AGENT_PRIVATE_KEY and VERIPAYAI_API_KEY. Fails closed, matching
 * lib/platform/auth.ts's precedent: an unset or malformed master key means
 * this module refuses to encrypt OR decrypt, never falls back to a
 * default/weak key just to keep the feature working.
 *
 * Server-only.
 */
import "server-only";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM-standard 96-bit nonce

export interface EncryptedKeyRecord {
  /** Base64. Random per encryption — GCM's security depends on never
   *  reusing a (key, iv) pair, so a fresh IV is drawn on every call. */
  iv: string;
  /** Base64. GCM's authentication tag — decryption fails closed if the
   *  ciphertext or this tag was altered in any way since encryption. */
  authTag: string;
  /** Base64 ciphertext. */
  data: string;
}

/** Thrown for every failure mode here — missing/malformed master key,
 *  tampered ciphertext, wrong key. Deliberately one error type: callers
 *  should treat "can't decrypt" as fully opaque (never branch on WHY it
 *  failed) so a caller can't be tricked into a different code path by
 *  crafting a specific failure shape. */
export class TelegramWalletCryptoError extends Error {}

/** Reads and validates the master key. Never caches it in a module-level
 *  variable — re-reading env on every call keeps this safe to call from a
 *  short-lived serverless invocation with no first-call/cold-start subtlety,
 *  and the cost of parsing 44 base64 chars is not worth optimizing away. */
function getMasterKey(): Buffer {
  const raw = process.env.TELEGRAM_WALLET_MASTER_KEY?.trim();
  if (!raw) {
    throw new TelegramWalletCryptoError(
      "TELEGRAM_WALLET_MASTER_KEY is not set — refusing to encrypt or decrypt a wallet key rather than fall back to an unprotected default.",
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new TelegramWalletCryptoError("TELEGRAM_WALLET_MASTER_KEY is not valid base64.");
  }
  if (key.length !== KEY_BYTES) {
    throw new TelegramWalletCryptoError(`TELEGRAM_WALLET_MASTER_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}).`);
  }
  return key;
}

/** Encrypts a `0x`-prefixed private key hex string for storage. */
export function encryptWalletKey(privateKeyHex: string): EncryptedKeyRecord {
  const key = getMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(privateKeyHex, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** Decrypts a stored record back to the `0x`-prefixed private key hex
 *  string. Throws TelegramWalletCryptoError on any failure — wrong master
 *  key, corrupted/tampered record, or malformed base64 — never returns a
 *  best-effort or partial result. */
export function decryptWalletKey(record: EncryptedKeyRecord): string {
  const key = getMasterKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, "base64"));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // Covers: wrong master key, flipped bytes anywhere in {iv, authTag,
    // data}, or a record that was never a real GCM ciphertext at all.
    // GCM's own auth-tag check is what makes tampering detectable here —
    // without it, a corrupted ciphertext would decrypt to silent garbage
    // instead of throwing.
    throw new TelegramWalletCryptoError("Could not decrypt wallet key — wrong master key, or the stored record was tampered with or corrupted.");
  }
}
