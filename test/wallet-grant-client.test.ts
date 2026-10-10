import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureWalletGrant, SIGN_TIMEOUT_MS, currentGrantAddress } from "@/lib/auth/ensureWalletGrant";
import { WALLET_GRANT_TTL_MS, walletGrantMessage } from "@/lib/auth/walletGrantShared";

/**
 * The browser side of the wallet grant. fetch and the signer are fakes; no
 * wallet, key or network is involved, and no real signature is ever made.
 */
const ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

interface Call { url: string; method: string; body: unknown }
let calls: Call[];
let getAddress: string | null | "throw";
let postResponse: { status: number; body?: unknown } | "throw";

function installFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") {
      if (getAddress === "throw") throw new Error("offline");
      return new Response(JSON.stringify({ address: getAddress }), { status: 200 });
    }
    if (postResponse === "throw") throw new Error("offline");
    return new Response(JSON.stringify(postResponse.body ?? {}), { status: postResponse.status });
  }));
}

beforeEach(() => {
  getAddress = null;
  postResponse = { status: 200, body: { address: ADDR.toLowerCase() } };
  installFetch();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensureWalletGrant", () => {
  it("does not ask the wallet to sign when a matching grant already exists", async () => {
    getAddress = ADDR.toLowerCase();
    const sign = vi.fn();
    expect(await ensureWalletGrant(ADDR, sign)).toEqual({ ok: true, via: "existing" });
    expect(sign).not.toHaveBeenCalled();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a null grant is NOT treated as already handled: it signs and POSTs", async () => {
    const sign = vi.fn(async () => "0xsig");
    const r = await ensureWalletGrant(ADDR, sign);
    expect(r).toEqual({ ok: true, via: "issued" });
    expect(sign).toHaveBeenCalledTimes(1);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/auth/wallet-grant");
    const body = post.body as { address: string; expiresAt: number; signature: string };
    expect(body.address).toBe(ADDR);
    expect(Object.keys(body).sort()).toEqual(["address", "expiresAt", "signature"]);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + WALLET_GRANT_TTL_MS + 1000);
  });

  it("signs exactly the grant message for that address and expiry, and nothing else", async () => {
    const sign = vi.fn(async (_m: string) => "0xsig");
    await ensureWalletGrant(ADDR, sign);
    const body = calls.find((c) => c.method === "POST")!.body as { expiresAt: number };
    expect(sign).toHaveBeenCalledWith(walletGrantMessage(ADDR, body.expiresAt));
    expect(sign.mock.calls[0][0]).toContain("It cannot move funds");
  });

  it("a wallet that refuses or throws is reported, with no POST", async () => {
    const r = await ensureWalletGrant(ADDR, async () => { throw new Error("User rejected"); });
    expect(r).toEqual({ ok: false, reason: "sign-failed" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an empty signature is a failure, never posted", async () => {
    const r = await ensureWalletGrant(ADDR, async () => "");
    expect(r).toEqual({ ok: false, reason: "sign-failed" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it.each([
    [401, { code: "grant_signature_invalid" }, "rejected"],
    [401, { code: "grant_expiry_invalid" }, "clock"],
    [401, {}, "rejected"],
    [429, {}, "rate-limited"],
    [500, {}, "server"],
    [503, { code: "grant_unavailable" }, "server"],
  ])("POST %s %j is reported as %s", async (status, body, reason) => {
    postResponse = { status, body };
    expect(await ensureWalletGrant(ADDR, async () => "0xsig")).toEqual({ ok: false, reason, status });
  });

  it("an unreachable endpoint is reported as network", async () => {
    postResponse = "throw";
    expect(await ensureWalletGrant(ADDR, async () => "0xsig")).toEqual({ ok: false, reason: "network" });
  });

  it("a failed attempt does not wedge the next one: it can retry and succeed", async () => {
    postResponse = { status: 500 };
    expect((await ensureWalletGrant(ADDR, async () => "0xsig")).ok).toBe(false);
    postResponse = { status: 200, body: {} };
    expect(await ensureWalletGrant(ADDR, async () => "0xsig")).toEqual({ ok: true, via: "issued" });
  });

  it("concurrent calls for one wallet share one prompt", async () => {
    let release!: (s: string) => void;
    const sign = vi.fn(() => new Promise<string>((res) => { release = res; }));
    const a = ensureWalletGrant(ADDR, sign);
    const b = ensureWalletGrant(ADDR.toLowerCase(), sign);
    await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
    release("0xsig");
    expect(await a).toEqual(await b);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("a signer that never answers times out instead of pinning the in-flight slot forever", async () => {
    vi.useFakeTimers();
    const stuck = ensureWalletGrant(ADDR, () => new Promise<string>(() => {}));
    await vi.advanceTimersByTimeAsync(SIGN_TIMEOUT_MS + 10);
    expect(await stuck).toEqual({ ok: false, reason: "sign-timeout" });
    vi.useRealTimers();
    // The slot is free again: a later attempt signs normally.
    expect(await ensureWalletGrant(ADDR, async () => "0xsig")).toEqual({ ok: true, via: "issued" });
  });

  it("writes the failure reason to the console without any secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    postResponse = { status: 401, body: { code: "grant_expiry_invalid" } };
    await ensureWalletGrant(ADDR, async () => "0xSECRETSIGNATURE");
    await Promise.resolve();
    const line = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("clock");
    expect(line).not.toContain("0xSECRETSIGNATURE");
  });

  it("currentGrantAddress is read-only, lowercase, and undefined when unreachable", async () => {
    getAddress = ADDR;
    expect(await currentGrantAddress()).toBe(ADDR.toLowerCase());
    getAddress = null;
    expect(await currentGrantAddress()).toBeNull();
    getAddress = "throw";
    expect(await currentGrantAddress()).toBeUndefined();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});
