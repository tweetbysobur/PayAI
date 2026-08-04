import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Wallet Service registry", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("Mera is unavailable with no credentials configured", async () => {
    delete process.env.MERA_API_KEY;
    delete process.env.MERA_PROJECT_ID;
    const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
    const provider = getEmbeddedProvider();
    expect(provider.id).toBe("mera");
    expect(await provider.isAvailable()).toBe(false);
  });

  it("Mera reports available once both env vars are set", async () => {
    process.env.MERA_API_KEY = "test-key";
    process.env.MERA_PROJECT_ID = "test-project";
    const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
    const provider = getEmbeddedProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it("createOrRecoverWallet refuses cleanly when not configured — never fabricates an address", async () => {
    delete process.env.MERA_API_KEY;
    delete process.env.MERA_PROJECT_ID;
    const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
    const provider = getEmbeddedProvider();
    await expect(provider.createOrRecoverWallet({ userId: "google:123", authMethod: "google" })).rejects.toThrow(
      /not configured/i,
    );
  });
});

describe("Session cookie codec", () => {
  beforeEach(() => {
    process.env.AUTH_SESSION_SECRET = "test-secret";
  });

  it("round-trips a session and rejects a tampered payload", async () => {
    const { encodeSession, decodeSession } = await import("@/lib/auth/session");
    const session = { userId: "google:1", authMethod: "google" as const, label: "a@b.com", address: "0xabc", createdAt: Date.now() };
    const encoded = encodeSession(session);
    expect(decodeSession(encoded)).toEqual(session);

    const [payload] = encoded.split(".");
    const tampered = `${payload}.deadbeef`;
    expect(decodeSession(tampered)).toBeNull();
    expect(decodeSession(undefined)).toBeNull();
    expect(decodeSession("")).toBeNull();
  });
});
