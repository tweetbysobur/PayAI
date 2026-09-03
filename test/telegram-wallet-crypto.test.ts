import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

/**
 * lib/telegram/walletCrypto.ts is the ONLY place in the app that persists a
 * private key it generated itself (everywhere else reads one once from env
 * and never stores it) — so its failure modes matter more than most: a bug
 * here either lets a tampered ciphertext decrypt to garbage that then signs
 * a transaction, or silently falls back to an unprotected default when the
 * master key is missing. Every case below is checking one of those two
 * things stays impossible.
 */

const GOOD_KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

// No vi.resetModules() needed between tests: the module holds no top-level
// state (getMasterKey() re-reads process.env on every call, by design), so
// re-importing the cached module and re-setting the env var is sufficient.
afterEach(() => {
  delete process.env.TELEGRAM_WALLET_MASTER_KEY;
});

describe("encryptWalletKey / decryptWalletKey — round trip", () => {
  it("decrypts back to exactly the original private key hex", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = GOOD_KEY;
    const { encryptWalletKey, decryptWalletKey } = await import("@/lib/telegram/walletCrypto");
    const original = "0x" + "ab".repeat(32);
    const record = encryptWalletKey(original);
    expect(decryptWalletKey(record)).toBe(original);
  });

  it("two encryptions of the same key produce different ciphertext and different IVs -- a fresh IV every time", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = GOOD_KEY;
    const { encryptWalletKey } = await import("@/lib/telegram/walletCrypto");
    const original = "0x" + "cd".repeat(32);
    const a = encryptWalletKey(original);
    const b = encryptWalletKey(original);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });
});

describe("decryptWalletKey — fails closed on tampering or the wrong key", () => {
  it("a single flipped byte in the ciphertext fails to decrypt rather than returning corrupted data", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = GOOD_KEY;
    const { encryptWalletKey, decryptWalletKey, TelegramWalletCryptoError } = await import("@/lib/telegram/walletCrypto");
    const record = encryptWalletKey("0x" + "11".repeat(32));
    const bytes = Buffer.from(record.data, "base64");
    bytes[0] ^= 0xff; // flip one bit's worth of byte
    const tampered = { ...record, data: bytes.toString("base64") };
    expect(() => decryptWalletKey(tampered)).toThrow(TelegramWalletCryptoError);
  });

  it("a tampered auth tag fails to decrypt", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = GOOD_KEY;
    const { encryptWalletKey, decryptWalletKey, TelegramWalletCryptoError } = await import("@/lib/telegram/walletCrypto");
    const record = encryptWalletKey("0x" + "22".repeat(32));
    const tagBytes = Buffer.from(record.authTag, "base64");
    tagBytes[0] ^= 0xff;
    const tampered = { ...record, authTag: tagBytes.toString("base64") };
    expect(() => decryptWalletKey(tampered)).toThrow(TelegramWalletCryptoError);
  });

  it("decrypting with a DIFFERENT master key than the one used to encrypt fails closed", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = GOOD_KEY;
    const { encryptWalletKey } = await import("@/lib/telegram/walletCrypto");
    const record = encryptWalletKey("0x" + "33".repeat(32));

    process.env.TELEGRAM_WALLET_MASTER_KEY = OTHER_KEY;
    const { decryptWalletKey, TelegramWalletCryptoError } = await import("@/lib/telegram/walletCrypto");
    expect(() => decryptWalletKey(record)).toThrow(TelegramWalletCryptoError);
  });
});

describe("missing or malformed master key refuses rather than falling back to a weak default", () => {
  it("encryptWalletKey throws when TELEGRAM_WALLET_MASTER_KEY is unset", async () => {
    delete process.env.TELEGRAM_WALLET_MASTER_KEY;
    const { encryptWalletKey, TelegramWalletCryptoError } = await import("@/lib/telegram/walletCrypto");
    expect(() => encryptWalletKey("0x" + "44".repeat(32))).toThrow(TelegramWalletCryptoError);
  });

  it("decryptWalletKey throws when TELEGRAM_WALLET_MASTER_KEY is unset, even for an otherwise-valid record", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = GOOD_KEY;
    const { encryptWalletKey } = await import("@/lib/telegram/walletCrypto");
    const record = encryptWalletKey("0x" + "55".repeat(32));

    delete process.env.TELEGRAM_WALLET_MASTER_KEY;
    const { decryptWalletKey, TelegramWalletCryptoError } = await import("@/lib/telegram/walletCrypto");
    expect(() => decryptWalletKey(record)).toThrow(TelegramWalletCryptoError);
  });

  it("a master key that isn't exactly 32 bytes once base64-decoded is rejected, not silently truncated/padded", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = randomBytes(16).toString("base64"); // too short
    const { encryptWalletKey, TelegramWalletCryptoError } = await import("@/lib/telegram/walletCrypto");
    expect(() => encryptWalletKey("0x" + "66".repeat(32))).toThrow(TelegramWalletCryptoError);
  });
});
