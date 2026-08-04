import { describe, it, expect } from "vitest";
import {
  defaultUsername, validateUsername, normalizeUsername, formatUsername, renameMessage,
} from "@/lib/platform/username";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("PayAI usernames", () => {
  it("gives every wallet a handle with no signup and nothing stored", () => {
    const name = defaultUsername(A);
    expect(name).toBeTruthy();
    expect(validateUsername(name).ok, `generated "${name}" must satisfy its own rules`).toBe(true);
  });

  it("is stable for a wallet and different across wallets", () => {
    // Stability is the whole point: the default must survive a new device or
    // a cleared cache, because it is derived rather than persisted.
    expect(defaultUsername(A)).toBe(defaultUsername(A));
    expect(defaultUsername(A.toUpperCase())).toBe(defaultUsername(A.toLowerCase()));
    expect(defaultUsername(A)).not.toBe(defaultUsername(B));
  });

  it("spreads across the word lists rather than clustering", () => {
    const names = new Set<string>();
    for (let i = 0; i < 300; i++) {
      names.add(defaultUsername(`0x${i.toString(16).padStart(40, "0")}`));
    }
    // Not a uniqueness guarantee — handles are not a reserved namespace — but
    // near-total collisions would make them useless as identifiers.
    expect(names.size).toBeGreaterThan(290);
  });

  it("rejects names that would be confusing or impersonating", () => {
    for (const bad of ["ab", "a".repeat(21), "-lead", "trail-", "Has Space", "emoji🙂", "UPPER!"]) {
      expect(validateUsername(bad).ok, `"${bad}" must be rejected`).toBe(false);
    }
    for (const reserved of ["payai", "support", "admin", "monad", "security"]) {
      expect(validateUsername(reserved).ok, `"${reserved}" must be reserved`).toBe(false);
    }
    // Every rejection must explain itself — these strings go straight to a user.
    expect(validateUsername("ab").error).toMatch(/3 characters/i);
  });

  it("accepts ordinary handles", () => {
    for (const good of ["gentle", "swift-otter", "user123", "a-b-c", "abc"]) {
      expect(validateUsername(good).ok, `"${good}" should be allowed`).toBe(true);
    }
  });

  it("treats @Name and name as the same handle", () => {
    expect(normalizeUsername("@Gentle")).toBe("gentle");
    expect(normalizeUsername("  GENTLE  ")).toBe("gentle");
    expect(formatUsername("gentle")).toBe("@gentle");
    expect(formatUsername("@gentle")).toBe("@gentle");
  });

  it("binds the rename signature to both the wallet and the new name", () => {
    // If either were missing, a captured signature could be replayed to claim
    // a different name, or to rename a different wallet.
    const msg = renameMessage(A, "gentle");
    expect(msg).toContain(A.toLowerCase());
    expect(msg).toContain("@gentle");
    expect(renameMessage(A, "gentle")).not.toBe(renameMessage(A, "other"));
    expect(renameMessage(A, "gentle")).not.toBe(renameMessage(B, "gentle"));
    // Client and server must derive the identical message from equivalent input.
    expect(renameMessage(A.toUpperCase(), "@Gentle")).toBe(renameMessage(A, "gentle"));
  });
});
