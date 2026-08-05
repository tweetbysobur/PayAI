import { describe, it, expect } from "vitest";
import {
  validateUsername, normalizeUsername, formatUsername, renameMessage,
  confusableSkeleton, shortAddress,
} from "@/lib/platform/username";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("PayAI usernames", () => {
  it("shows a short address, not an invented name, until one is chosen", () => {
    // A generated handle would look like the user had named themselves when
    // they hadn't. The address is honest and unambiguous.
    expect(shortAddress(A)).toBe("0x1111…1111");
  });

  it("accepts ordinary handles", () => {
    for (const good of ["gentle", "swift-otter", "user123", "a-b-c", "abc", "my_name"]) {
      expect(validateUsername(good).ok, `"${good}" should be allowed`).toBe(true);
    }
  });

  it("rejects malformed handles with an explanation a user can act on", () => {
    for (const bad of ["ab", "a".repeat(21), "-lead", "trail-", "Has Space", "emoji🙂", "UPPER!"]) {
      expect(validateUsername(bad).ok, `"${bad}" must be rejected`).toBe(false);
    }
    expect(validateUsername("ab").error).toMatch(/3 characters/i);
    expect(validateUsername("a b").error).toMatch(/lowercase/i);
  });

  it("reserves names that could be used to impersonate PayAI or its staff", () => {
    for (const reserved of ["payai", "support", "admin", "security", "team", "founder", "verified", "monad"]) {
      expect(validateUsername(reserved).ok, `"${reserved}" must be reserved`).toBe(false);
    }
  });

  it("blocks look-alike spellings of reserved names", () => {
    // The impersonation risk isn't "payai" — it's "pay4i" next to it in a
    // payment confirmation, where nobody reads carefully.
    for (const lookalike of ["pay4i", "p4yai", "supp0rt", "5ecurity", "adm1n", "p-a-y-a-i"]) {
      expect(validateUsername(lookalike).ok, `"${lookalike}" must be blocked`).toBe(false);
    }
  });

  it("treats confusable spellings as one claim, so a taken name can't be re-registered", () => {
    // Same skeleton => same KV claim key => first come, first served covers
    // the look-alike too.
    expect(confusableSkeleton("gentle")).toBe(confusableSkeleton("g3ntle"));
    expect(confusableSkeleton("swift-otter")).toBe(confusableSkeleton("swift_otter"));
    expect(confusableSkeleton("s0bur")).toBe(confusableSkeleton("sobur"));
    expect(confusableSkeleton("alice")).not.toBe(confusableSkeleton("bob"));
  });

  it("treats @Name and name as the same handle", () => {
    expect(normalizeUsername("@Gentle")).toBe("gentle");
    expect(normalizeUsername("  GENTLE  ")).toBe("gentle");
    expect(normalizeUsername("@@weird")).toBe("weird");
    expect(formatUsername("gentle")).toBe("@gentle");
    expect(formatUsername("@gentle")).toBe("@gentle");
  });

  it("binds the claim signature to both the wallet and the name", () => {
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
