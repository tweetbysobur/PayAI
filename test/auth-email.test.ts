import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** Captures the code out of the outbound mail request, so these tests never
 *  need the code to be readable from storage — which is the point: it isn't. */
function mockMailer(): { codes: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const codes: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const match = /\b(\d{6})\b/.exec(body.subject ?? "");
    if (match) codes.push(match[1]);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { codes, restore: () => { globalThis.fetch = original; } };
}

describe("email sign-in codes", () => {
  const ORIGINAL = { ...process.env };
  let mailer: ReturnType<typeof mockMailer>;

  beforeEach(() => {
    process.env.AUTH_EMAIL_API_KEY = "test-key";
    process.env.AUTH_EMAIL_FROM = "PayAI <login@usepayai.xyz>";
    // Deliberately NOT resetting __payaiEmailCodes here: the module binds
    // that global once at import, so replacing it mid-suite would leave the
    // module writing to a map the tests can't see. Each test uses its own
    // address (or re-sends, which overwrites) instead.
    mailer = mockMailer();
  });
  afterEach(() => {
    mailer.restore();
    process.env = { ...ORIGINAL };
    vi.useRealTimers();
  });

  it("refuses to send when no mail provider is configured", async () => {
    delete process.env.AUTH_EMAIL_API_KEY;
    const { sendEmailCode, isEmailAuthConfigured } = await import("@/lib/auth/email");
    expect(isEmailAuthConfigured()).toBe(false);
    await expect(sendEmailCode("a@b.com")).rejects.toThrow(/not configured/i);
  });

  it("accepts the emailed code exactly once, then never again", async () => {
    const { sendEmailCode, verifyEmailCode } = await import("@/lib/auth/email");
    await sendEmailCode("a@b.com");
    const code = mailer.codes[0];
    expect(code).toMatch(/^\d{6}$/);

    expect(await verifyEmailCode("a@b.com", code)).toBe(true);
    // Replay of an already-consumed code must fail.
    expect(await verifyEmailCode("a@b.com", code)).toBe(false);
  });

  it("never persists the code in plaintext", async () => {
    const { sendEmailCode } = await import("@/lib/auth/email");
    await sendEmailCode("plaintext@b.com");
    const code = mailer.codes[0];

    // Read the map the module actually writes to (it binds this global once
    // at import), not a fresh one — otherwise this assertion would pass
    // vacuously against an empty store.
    const store = (globalThis as Record<string, unknown>).__payaiEmailCodes as Map<string, unknown>;
    const stored = JSON.stringify([...store.values()]);
    expect(stored).toContain("hash"); // guards against a vacuous pass
    expect(stored).not.toContain(code);
  });

  it("burns the code after too many wrong guesses", async () => {
    const { sendEmailCode, verifyEmailCode } = await import("@/lib/auth/email");
    await sendEmailCode("a@b.com");
    const code = mailer.codes[0];
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) expect(await verifyEmailCode("a@b.com", wrong)).toBe(false);
    // The real code is now worthless — the cap is what makes a 6-digit
    // code safe against online brute force.
    expect(await verifyEmailCode("a@b.com", code)).toBe(false);
  });

  it("rejects a code past its TTL", async () => {
    vi.useFakeTimers();
    const { sendEmailCode, verifyEmailCode } = await import("@/lib/auth/email");
    await sendEmailCode("a@b.com");
    const code = mailer.codes[0];
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(await verifyEmailCode("a@b.com", code)).toBe(false);
  });

  it("issuing a new code invalidates the previous one", async () => {
    const { sendEmailCode, verifyEmailCode } = await import("@/lib/auth/email");
    await sendEmailCode("a@b.com");
    const first = mailer.codes[0];
    await sendEmailCode("a@b.com");
    const second = mailer.codes[1];

    expect(await verifyEmailCode("a@b.com", first)).toBe(false);
    expect(await verifyEmailCode("a@b.com", second)).toBe(true);
  });

  it("does not leave a usable code behind when delivery fails", async () => {
    const { sendEmailCode, verifyEmailCode } = await import("@/lib/auth/email");
    // Capture the code, then fail the send.
    const original = globalThis.fetch;
    let sent = "";
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      sent = /\b(\d{6})\b/.exec(JSON.parse(String(init?.body ?? "{}")).subject ?? "")?.[1] ?? "";
      return new Response("upstream boom", { status: 502 });
    }) as unknown as typeof fetch;

    await expect(sendEmailCode("a@b.com")).rejects.toThrow(/502/);
    globalThis.fetch = original;
    expect(sent).toMatch(/^\d{6}$/);
    expect(await verifyEmailCode("a@b.com", sent)).toBe(false);
  });

  it("a code issued for one address is useless for another", async () => {
    const { sendEmailCode, verifyEmailCode } = await import("@/lib/auth/email");
    await sendEmailCode("a@b.com");
    await sendEmailCode("c@d.com");
    const [forA] = mailer.codes;
    expect(await verifyEmailCode("c@d.com", forA)).toBe(false);
  });
});
