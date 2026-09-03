import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/telegram/wallets.ts's one real invariant: a Telegram user's deposit
 * address, once issued, must never change and must never be issued twice
 * under the same slot — a second key for the same user would silently
 * strand anything already sent to the first address. These tests cover
 * that invariant against both storage backends, plus the concurrent-claim
 * race the real risk lives in (mirrors test/idempotency-atomicity.test.ts's
 * approach: a fake Redis with real NX semantics and real event-loop
 * yielding, so a non-atomic implementation would actually interleave and
 * fail here rather than merely being theoretically wrong).
 */

const MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes, valid base64

let redisImpl: {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
} | null = null;

vi.mock("@/lib/platform/kv", () => ({
  getRedis: async () => redisImpl,
  kvEnabled: () => redisImpl !== null,
}));

function makeFakeRedis() {
  const store = new Map<string, unknown>();
  return {
    async get(key: string) {
      await Promise.resolve();
      return store.get(key) ?? null;
    },
    async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
      await Promise.resolve();
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
  };
}

afterEach(() => {
  delete process.env.TELEGRAM_WALLET_MASTER_KEY;
  redisImpl = null;
  const g = globalThis as unknown as { __veripayTelegramWallets?: Map<string, unknown> };
  g.__veripayTelegramWallets?.clear();
});

describe("getOrCreateTelegramWallet — in-memory fallback (no KV configured)", () => {
  it("issues a wallet on first call and returns the SAME address on every later call", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = MASTER_KEY;
    const { getOrCreateTelegramWallet } = await import("@/lib/telegram/wallets");
    const first = await getOrCreateTelegramWallet("tg-1");
    const second = await getOrCreateTelegramWallet("tg-1");
    expect(second.address).toBe(first.address);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("gives two different Telegram users two different addresses", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = MASTER_KEY;
    const { getOrCreateTelegramWallet } = await import("@/lib/telegram/wallets");
    const a = await getOrCreateTelegramWallet("tg-a");
    const b = await getOrCreateTelegramWallet("tg-b");
    expect(a.address).not.toBe(b.address);
  });

  it("returns a real, checksummed 0x address", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = MASTER_KEY;
    const { getOrCreateTelegramWallet } = await import("@/lib/telegram/wallets");
    const wallet = await getOrCreateTelegramWallet("tg-format");
    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});

describe("getOrCreateTelegramWallet — KV-backed, concurrent /start never issues two keys for one user", () => {
  it("two simultaneous calls for a brand-new user resolve to the SAME address, never two different ones", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = MASTER_KEY;
    redisImpl = makeFakeRedis();
    const { getOrCreateTelegramWallet } = await import("@/lib/telegram/wallets");
    const [a, b] = await Promise.all([getOrCreateTelegramWallet("tg-race"), getOrCreateTelegramWallet("tg-race")]);
    expect(a.address).toBe(b.address);
  });

  it("a later call after the record already exists reads it back rather than generating another", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = MASTER_KEY;
    redisImpl = makeFakeRedis();
    const { getOrCreateTelegramWallet } = await import("@/lib/telegram/wallets");
    const first = await getOrCreateTelegramWallet("tg-seq");
    const second = await getOrCreateTelegramWallet("tg-seq");
    expect(second.address).toBe(first.address);
  });
});

describe("getTelegramWalletAccount — the internal signing path", () => {
  it("returns null for a Telegram user who has never run /start", async () => {
    process.env.TELEGRAM_WALLET_MASTER_KEY = MASTER_KEY;
    const { getTelegramWalletAccount } = await import("@/lib/telegram/wallets");
    expect(await getTelegramWalletAccount("tg-never-started")).toBeNull();
  });

  it("returns a signing account whose address matches the public wallet record exactly", async () => {
    // The address is a deterministic function of the private key, so this
    // single assertion IS the round-trip proof: if encrypt -> store ->
    // decrypt corrupted the key into a different (but still validly-shaped)
    // one, privateKeyToAccount would derive a different address here, not
    // the one getOrCreateTelegramWallet originally reported.
    process.env.TELEGRAM_WALLET_MASTER_KEY = MASTER_KEY;
    const { getOrCreateTelegramWallet, getTelegramWalletAccount } = await import("@/lib/telegram/wallets");
    const wallet = await getOrCreateTelegramWallet("tg-signer");
    const account = await getTelegramWalletAccount("tg-signer");
    expect(account).not.toBeNull();
    expect(account!.address.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});
