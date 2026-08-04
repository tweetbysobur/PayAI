import { describe, it, expect, beforeEach } from "vitest";

describe("Wallet Service registry", () => {
  it("exposes Mera as the active embedded provider", async () => {
    const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
    const provider = getEmbeddedProvider();
    expect(provider.id).toBe("mera");
    expect(provider.kind).toBe("embedded");
  });

  it("reports itself unsupported where passkeys don't exist, instead of throwing", async () => {
    // No `window`/WebAuthn in the test environment — the same situation as a
    // browser without passkey support. The UI relies on this being a clean
    // `false` so it can steer to an external wallet rather than dead-ending
    // the user in a flow their device can't finish.
    const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
    const provider = getEmbeddedProvider();
    expect(provider.isSupported()).toBe(false);
    expect(provider.hasLocalCredential()).toBe(false);
  });

  it("turns a cancelled passkey prompt into language a user can act on", async () => {
    const { getEmbeddedProvider } = await import("@/lib/wallet-service/registry");
    const { MeraError } = await import("@category-labs/mera");
    const provider = getEmbeddedProvider();

    const cancelled = provider.friendlyError(new MeraError("PASSKEY_OPERATION_FAILED", "raw"));
    expect(cancelled).toMatch(/cancelled|try again/i);
    // A device whose authenticator can't do PRF cannot ever derive a wallet;
    // that must point at the external-wallet escape hatch, not just retry.
    const noPrf = provider.friendlyError(new MeraError("PRF_UNAVAILABLE", "raw"));
    expect(noPrf).toMatch(/existing wallet|another device/i);
  });
});

describe("Session cookie codec", () => {
  beforeEach(() => {
    process.env.AUTH_SESSION_SECRET = "test-secret";
  });

  it("round-trips a session and rejects a tampered payload", async () => {
    const { encodeSession, decodeSession } = await import("@/lib/auth/session");
    const session = { userId: "google:1", authMethod: "google" as const, label: "a@b.com", createdAt: Date.now() };
    const encoded = encodeSession(session);
    expect(decodeSession(encoded)).toEqual(session);

    const [payload] = encoded.split(".");
    expect(decodeSession(`${payload}.deadbeef`)).toBeNull();
    expect(decodeSession(undefined)).toBeNull();
    expect(decodeSession("")).toBeNull();
  });

  it("carries no wallet address — the server never learns one", async () => {
    const { encodeSession, decodeSession } = await import("@/lib/auth/session");
    const decoded = decodeSession(
      encodeSession({ userId: "email:a@b.com", authMethod: "email", label: "a@b.com", createdAt: 1 }),
    );
    // The wallet is derived from a passkey in the browser. If an address ever
    // appears in this cookie, key handling has moved server-side and the
    // security model has silently changed.
    expect(decoded).not.toHaveProperty("address");
  });
});
