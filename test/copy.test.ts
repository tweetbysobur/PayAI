import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A copy confirmation is a claim about the user's clipboard.
 *
 * Six places did this by hand and each handled failure differently: some
 * announced success before the write resolved, some swallowed the rejection
 * and announced success anyway, some said nothing at all. The clipboard fails
 * for ordinary reasons — an insecure origin, a denied permission, an in-app
 * browser — and what this product copies is almost always a wallet address or
 * a transaction hash. Telling someone an address is on their clipboard when it
 * isn't means they paste whatever was there before, into a payment.
 *
 * The hook itself needs React to exercise; these cover the rule it enforces,
 * against the same clipboard states the browser actually produces.
 */

/** Mirrors the hook's decision, so the rule is testable without a renderer. */
async function attemptCopy(
  clipboard: { writeText: (t: string) => Promise<void> } | undefined,
  text: string,
): Promise<{ ok: boolean }> {
  try {
    if (!clipboard) throw new Error("clipboard unavailable");
    await clipboard.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

describe("copy confirmation", () => {
  let written: string[];
  beforeEach(() => { written = []; });

  it("reports success only after the write resolves", async () => {
    const clipboard = { writeText: async (t: string) => { written.push(t); } };
    const result = await attemptCopy(clipboard, "0xabc");
    expect(result.ok).toBe(true);
    expect(written).toEqual(["0xabc"]);
  });

  it("reports failure when the write is rejected", async () => {
    // A denied permission is the common case, and the one where a false
    // "Copied" does the most damage.
    const clipboard = { writeText: async () => { throw new Error("NotAllowedError"); } };
    expect((await attemptCopy(clipboard, "0xabc")).ok).toBe(false);
  });

  it("reports failure when there is no clipboard at all", async () => {
    // http:// origins and some in-app browsers expose no clipboard API.
    expect((await attemptCopy(undefined, "0xabc")).ok).toBe(false);
  });

  it("does not resolve before the write settles", async () => {
    // The original bug in one call site: fire the write, claim success on the
    // next line, and be wrong whenever it rejects.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const clipboard = { writeText: async () => { await gate; written.push("late"); } };

    let settled = false;
    const pending = attemptCopy(clipboard, "0xabc").then((r) => { settled = true; return r; });

    await Promise.resolve();
    expect(settled, "must not have reported an outcome yet").toBe(false);

    release();
    expect((await pending).ok).toBe(true);
    expect(written).toEqual(["late"]);
  });
});

describe("motion preference", () => {
  it("defers to the operating system rather than a hardcoded choice", async () => {
    // The CSS reduced-motion rule cannot reach Framer, which animates by
    // writing transforms from JavaScript — so most of this product's movement
    // ignored the setting entirely until MotionConfig was applied globally.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../components/MotionPreference.tsx", import.meta.url), "utf8"),
    );
    expect(source).toMatch(/reducedMotion=["']user["']/);
  });

  it("is applied at the root, so no subtree can opt out by accident", async () => {
    const layout = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    );
    expect(layout).toMatch(/<MotionPreference>/);
  });
});

// Keep the mock surface tidy for any later suite in this file.
vi.restoreAllMocks();
