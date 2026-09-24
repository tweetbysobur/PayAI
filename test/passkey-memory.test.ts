import { describe, expect, it } from "vitest";
import {
  encodePasskeyCookie,
  parsePasskeyMemory,
  passkeyCookieAttributes,
  readCookieValue,
} from "@/lib/wallet-service/passkey-memory";

describe("passkey memory", () => {
  const memory = {
    credentialId: "abc_DEF-123",
    address: "0x2222222222222222222222222222222222222222",
    transports: ["internal"],
  };

  it("round-trips a credential through the parent-domain cookie encoding", () => {
    expect(parsePasskeyMemory(encodePasskeyCookie(memory))).toEqual(memory);
  });

  it("rejects a credential id that is not an opaque public identifier", () => {
    expect(parsePasskeyMemory(JSON.stringify({ credentialId: "has space" }))).toBeNull();
    expect(parsePasskeyMemory("not-json-or-base64url!!!")).toBeNull();
  });

  it("scopes the cookie to .usepayai.xyz and not to other hosts", () => {
    expect(passkeyCookieAttributes("app.usepayai.xyz", true)).toContain("Domain=.usepayai.xyz");
    expect(passkeyCookieAttributes("app.usepayai.xyz", true)).toContain("Secure");
    expect(passkeyCookieAttributes("localhost", false)).not.toContain("Domain=");
    expect(passkeyCookieAttributes("veripayai.vercel.app", true)).not.toContain("Domain=");
  });

  it("reads the last cookie when both a host cookie and a parent cookie are present", () => {
    const header = "payai_pk=old; other=1; payai_pk=" + encodeURIComponent(encodePasskeyCookie(memory));
    expect(parsePasskeyMemory(readCookieValue(header, "payai_pk"))).toEqual(memory);
  });
});
