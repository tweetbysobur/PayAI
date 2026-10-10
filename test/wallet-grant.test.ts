import { describe, expect, it, vi } from "vitest";
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

  it("the signed message states exactly what the grant allows — and that it can't move funds or sign transactions", () => {
    expect(walletGrantMessage(owner.address, 1_700_000_000_000)).toBe([
      "PayAI wallet access",
      `Address: ${owner.address.toLowerCase()}`,
      "Expires: 1700000000000",
      "This lets this browser access your PayAI data and manage your PayAI plans.",
      "It cannot move funds, and it cannot sign or authorize blockchain transactions.",
    ].join("\n"));
  });

  it("does not list someone's automations from their address alone", async () => {
    const res = await listAutomations(new NextRequest(
      `https://app.usepayai.xyz/api/automations?wallet=${owner.address}`,
    ));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "wallet_grant_required", automations: [] });
  });
});

describe("wallet grant issuer: failure codes and bounds", () => {
  const post = (body: unknown) => POST(new NextRequest("https://app.usepayai.xyz/api/auth/wallet-grant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const signed = async (expiresAt: number) => ({
    address: owner.address,
    expiresAt,
    signature: await owner.signMessage({ message: walletGrantMessage(owner.address, expiresAt) }),
  });

  it("a wrong signature names grant_signature_invalid", async () => {
    const expiresAt = Date.now() + 60_000;
    const res = await post({ address: owner.address, expiresAt, signature: await other.signMessage({ message: walletGrantMessage(owner.address, expiresAt) }) });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "grant_signature_invalid" });
  });

  it("a correctly signed grant whose expiry is beyond the window is refused as grant_expiry_invalid (a fast clock)", async () => {
    const res = await post(await signed(Date.now() + WALLET_GRANT_TTL_MS + 5 * 60_000));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "grant_expiry_invalid" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the window itself is unchanged: 12h + 30s of skew is still accepted, 12h + 2min is not", async () => {
    expect((await post(await signed(Date.now() + WALLET_GRANT_TTL_MS + 30_000))).status).toBe(200);
    expect((await post(await signed(Date.now() + WALLET_GRANT_TTL_MS + 120_000))).status).toBe(401);
  });

  it("an already-expired grant is refused", async () => {
    expect((await post(await signed(Date.now() - 120_000))).status).toBe(401);
  });

  it("without AUTH_SESSION_SECRET in production no grant is issued: a controlled 503, no cookie", async () => {
    const body = await signed(Date.now() + 60_000);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SESSION_SECRET", "");
    try {
      const res = await post(body);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "grant_unavailable" });
      expect(res.headers.get("set-cookie")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("garbage input is still just a 401", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ address: "nope", expiresAt: "x", signature: 1 })).status).toBe(401);
  });
});
