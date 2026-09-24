import { describe, expect, it } from "vitest";
import { getAccountWallet, isLinkableUserId, putAccountWallet } from "@/lib/platform/accountWallet";

describe("account wallet link", () => {
  it("stores a wallet for a real sign-in and returns it", async () => {
    const userId = "google:acct-wallet-test";
    expect(isLinkableUserId(userId)).toBe(true);
    const saved = await putAccountWallet(userId, {
      address: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
      credentialId: "cred_1",
    });
    expect(saved?.address).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect((await getAccountWallet(userId))?.credentialId).toBe("cred_1");
  });

  it("replaces an empty-wallet link when the original passkey is unlocked", async () => {
    const userId = "email:replace@example.com";
    await putAccountWallet(userId, { address: "0x1111111111111111111111111111111111111111", credentialId: "new" });
    await putAccountWallet(userId, { address: "0x2222222222222222222222222222222222222222", credentialId: "original" });
    expect((await getAccountWallet(userId))?.credentialId).toBe("original");
  });

  it("refuses ids that are not a provider account", async () => {
    expect(isLinkableUserId("no-colon")).toBe(false);
    expect(await putAccountWallet("no-colon", {
      address: "0x1111111111111111111111111111111111111111",
      credentialId: "cred",
    })).toBeNull();
    expect(await getAccountWallet("no-colon")).toBeNull();
  });
});
