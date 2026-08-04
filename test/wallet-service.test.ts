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

  it("exposes a `created` flag so wallet_created fires once, not on every sign-in", async () => {
    process.env.MERA_API_KEY = "test-key";
    process.env.MERA_PROJECT_ID = "test-project";
    const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
    const provider = getEmbeddedProvider();

    const originalFetch = globalThis.fetch;
    // A recovery response with no `created` field must read as false — a
    // returning user must never be told their wallet was just created.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ address: "0xabc", recoveryMethod: "google" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const recovered = await provider.createOrRecoverWallet({ userId: "google:1", authMethod: "google" });
      expect(recovered.created).toBe(false);
      expect(recovered.address).toBe("0xabc");

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ address: "0xabc", created: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const fresh = await provider.createOrRecoverWallet({ userId: "google:2", authMethod: "google" });
      expect(fresh.created).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
