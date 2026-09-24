import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { GET, POST } from "@/app/api/auth/wallet-grant/route";
import { GET as listAutomations } from "@/app/api/automations/route";
import {
  decodeWalletGrant,
  denyPrivateRead,
  encodeWalletGrant,
  WALLET_GRANT_COOKIE,
  WALLET_GRANT_TTL_MS,
  walletGrantMessage,
} from "@/lib/auth/walletGrant";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const owner = privateKeyToAccount(KEY);
const other = privateKeyToAccount(OTHER);

function cookieFor(address: string, expiresAt = Date.now() + WALLET_GRANT_TTL_MS): string {
  return `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(address, expiresAt)}`;
}

describe("wallet read grant", () => {
  it("rejects a cookie that was not signed by this deployment", () => {
    expect(decodeWalletGrant("aaaa.bbbb")).toBeNull();
  });

  it("rejects an expired grant", () => {
    expect(decodeWalletGrant(encodeWalletGrant(owner.address, Date.now() - 1_000))).toBeNull();
  });

  it("does not treat a grant for one wallet as access to another", async () => {
    const req = new NextRequest("https://app.usepayai.xyz/api/automations?wallet=" + other.address, {
      headers: { cookie: cookieFor(owner.address) },
    });
    const denied = await denyPrivateRead(req, other.address);
    expect(denied?.status).toBe(401);
  });

  it("allows the wallet that signed the grant", async () => {
    const req = new NextRequest("https://app.usepayai.xyz/api/automations?wallet=" + owner.address, {
      headers: { cookie: cookieFor(owner.address) },
    });
    expect(await denyPrivateRead(req, owner.address)).toBeNull();
  });

  it("refuses a signature from a different key", async () => {
    const expiresAt = Date.now() + 60_000;
    const signature = await other.signMessage({ message: walletGrantMessage(owner.address, expiresAt) });
    const res = await POST(new NextRequest("https://app.usepayai.xyz/api/auth/wallet-grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: owner.address, expiresAt, signature }),
    }));
    expect(res.status).toBe(401);
  });

  it("sets an httpOnly cookie only after the wallet signs", async () => {
    const expiresAt = Date.now() + 60_000;
    const signature = await owner.signMessage({ message: walletGrantMessage(owner.address, expiresAt) });
    const res = await POST(new NextRequest("https://app.usepayai.xyz/api/auth/wallet-grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: owner.address, expiresAt, signature }),
    }));
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toContain(WALLET_GRANT_COOKIE);
    const issued = await GET(new NextRequest("https://app.usepayai.xyz/api/auth/wallet-grant", {
      headers: { cookie: set.split(";")[0] },
    }));
    expect((await issued.json()).address).toBe(owner.address.toLowerCase());
  });

  it("does not list someone's automations from their address alone", async () => {
    const res = await listAutomations(new NextRequest(
      `https://app.usepayai.xyz/api/automations?wallet=${owner.address}`,
    ));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "wallet_grant_required", automations: [] });
  });
});
