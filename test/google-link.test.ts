import { describe, expect, it, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { POST, DELETE } from "@/app/api/auth/link/google/route";
import { GET as readLink } from "@/app/api/auth/linked-login/route";
import { applyGoogleLink, decodeLinkProof, encodeLinkProof, GOOGLE_LINK_COOKIE } from "@/lib/auth/linkGoogle";
import { decideGoogleLink, linkGoogleMessage, openedWalletMatchesAccount, unlinkGoogleMessage } from "@/lib/auth/linkGoogleShared";
import { getAccountWallet } from "@/lib/platform/accountWallet";
import { getLinkedLogin } from "@/lib/platform/linkedLogin";
import { encodeWalletGrant, WALLET_GRANT_COOKIE, WALLET_GRANT_TTL_MS } from "@/lib/auth/walletGrant";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const owner = privateKeyToAccount(KEY);
const other = privateKeyToAccount(OTHER);
const PASSKEY = "passkeyCred123";

describe("linking Google to an existing passkey wallet", () => {
  beforeEach(() => {
    const g = globalThis as unknown as {
      __payaiAccountWallet?: Map<string, unknown>;
      __payaiLinkedLogin?: Map<string, unknown>;
      __veripayRL?: Map<string, unknown>;
    };
    g.__payaiAccountWallet?.clear();
    g.__payaiLinkedLogin?.clear();
    g.__veripayRL?.clear();
  });
  it("does not treat a different passkey as the same account", () => {
    expect(openedWalletMatchesAccount("0xabc", "0xABC")).toBe(true);
    expect(openedWalletMatchesAccount("0xabc", "0xdef")).toBe(false);
    expect(openedWalletMatchesAccount(null, "0xdef")).toBe(true);
  });

  it("refuses a Google account that already opens another wallet", () => {
    expect(decideGoogleLink({
      googleUserId: "google:1",
      walletAddress: owner.address,
      existingForGoogle: { address: "0x2222222222222222222222222222222222222222" },
      existingForWallet: null,
    })).toBe("google-taken");
  });

  it("refuses a second Google account on a wallet that already has one", () => {
    expect(decideGoogleLink({
      googleUserId: "google:2",
      walletAddress: owner.address,
      existingForGoogle: null,
      existingForWallet: { userId: "google:1" },
    })).toBe("wallet-taken");
  });

  it("allows the same Google account to refresh the same wallet", () => {
    expect(decideGoogleLink({
      googleUserId: "google:1",
      walletAddress: owner.address,
      existingForGoogle: { address: owner.address },
      existingForWallet: { userId: "google:1" },
    })).toBe("link");
  });

  it("stores the link so a later Google sign-in finds this wallet", async () => {
    const userId = "google:link-store-1";
    const applied = await applyGoogleLink({
      googleUserId: userId,
      label: "owner@gmail.com",
      address: owner.address,
      credentialId: PASSKEY,
    });
    expect(applied.ok).toBe(true);
    expect((await getAccountWallet(userId))?.address).toBe(owner.address.toLowerCase());
    expect((await getLinkedLogin(owner.address))?.label).toBe("owner@gmail.com");
  });

  it("does not move an existing wallet when a second one tries to take its Google account", async () => {
    const userId = "google:link-store-2";
    await applyGoogleLink({
      googleUserId: userId,
      label: "owner@gmail.com",
      address: owner.address,
      credentialId: PASSKEY,
    });
    const stolen = await applyGoogleLink({
      googleUserId: userId,
      label: "owner@gmail.com",
      address: other.address,
      credentialId: "other-passkey",
    });
    expect(stolen).toEqual({ ok: false, reason: "google-taken" });
    expect((await getAccountWallet(userId))?.address).toBe(owner.address.toLowerCase());
  });

  it("accepts a passkey signature and ignores one from a different key", async () => {
    const expiresAt = Date.now() + 60_000;
    const message = linkGoogleMessage(owner.address, PASSKEY, expiresAt);
    const bad = await POST(new NextRequest("https://app.usepayai.xyz/api/auth/link/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: owner.address,
        credentialId: PASSKEY,
        expiresAt,
        signature: await other.signMessage({ message }),
      }),
    }));
    expect(bad.status).toBe(401);

    const good = await POST(new NextRequest("https://app.usepayai.xyz/api/auth/link/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address: owner.address,
        credentialId: PASSKEY,
        expiresAt,
        signature: await owner.signMessage({ message }),
      }),
    }));
    expect(good.status).toBe(200);
    const cookie = good.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    const proof = decodeLinkProof(cookie.split(";")[0].slice(GOOGLE_LINK_COOKIE.length + 1));
    expect(proof?.address).toBe(owner.address.toLowerCase());
    expect(proof?.credentialId).toBe(PASSKEY);
  });

  it("hides the Gmail address from someone who only knows the wallet", async () => {
    const address = "0x3333333333333333333333333333333333333333";
    await applyGoogleLink({
      googleUserId: "google:hidden",
      label: "hidden@gmail.com",
      address,
      credentialId: PASSKEY,
    });
    const hidden = await readLink(new NextRequest(`https://app.usepayai.xyz/api/auth/linked-login?address=${address}`));
    expect(hidden.status).toBe(401);
    expect((await hidden.json()).linked).toBeNull();

    const grant = `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(address, Date.now() + WALLET_GRANT_TTL_MS)}`;
    const shown = await readLink(new NextRequest(`https://app.usepayai.xyz/api/auth/linked-login?address=${address}`, {
      headers: { cookie: grant },
    }));
    expect((await shown.json()).linked).toEqual({ method: "google", label: "hidden@gmail.com" });
  });

  it("unlinks Google without deleting the wallet record's right to exist", async () => {
    const address = other.address;
    const userId = "google:unlink-me";
    await applyGoogleLink({ googleUserId: userId, label: "bye@gmail.com", address, credentialId: PASSKEY });
    const expiresAt = Date.now() + 60_000;
    const res = await DELETE(new NextRequest("https://app.usepayai.xyz/api/auth/link/google", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address,
        expiresAt,
        signature: await other.signMessage({ message: unlinkGoogleMessage(address, expiresAt) }),
      }),
    }));
    expect(res.status).toBe(200);
    expect(await getLinkedLogin(address)).toBeNull();
    expect(await getAccountWallet(userId)).toBeNull();
  });

  it("rejects a tampered link cookie", () => {
    const real = encodeLinkProof({ address: owner.address, credentialId: PASSKEY, expiresAt: Date.now() + 60_000 });
    expect(decodeLinkProof(`${real}x`)).toBeNull();
  });
});
