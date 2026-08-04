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

  it("treats an unverifiable cookie as signed-out instead of throwing", async () => {
    const { decodeSession } = await import("@/lib/auth/session");
    // Garbage, and a well-formed payload signed with a different secret —
    // both must read as "not signed in". If either threw, a stale cookie
    // would 500 every request that reads the session.
    expect(decodeSession("not-a-session")).toBeNull();
    expect(decodeSession("a.b")).toBeNull();
    expect(() => decodeSession("%%%.%%%")).not.toThrow();
  });

  it("reports social sign-in unusable in production without a signing secret", async () => {
    const { isSessionConfigured } = await import("@/lib/auth/session");
    const secret = process.env.AUTH_SESSION_SECRET;
    const nodeEnv = process.env.NODE_ENV;
    const setEnv = (k: string, v: string | undefined) => {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    };
    try {
      setEnv("AUTH_SESSION_SECRET", undefined);
      setEnv("NODE_ENV", "production");
      // Must be false so the UI shows "not set up" rather than sending the
      // user to Google and 500ing on the way back. The passkey wallet does
      // not consult this at all and keeps working.
      expect(isSessionConfigured()).toBe(false);

      setEnv("AUTH_SESSION_SECRET", "a-real-secret");
      expect(isSessionConfigured()).toBe(true);
    } finally {
      setEnv("NODE_ENV", nodeEnv);
      setEnv("AUTH_SESSION_SECRET", secret);
    }
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
