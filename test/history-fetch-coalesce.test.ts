import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One dashboard sync runs every registered refresher in the same tick, and two
 * of them (the bell and the home page) asked the server for the SAME wallet's
 * history — two identical reads of the transaction log per cycle. Identical
 * calls made in the same tick now share one request. A call from any later
 * tick (the refresh after a completed payment, the next heartbeat) always
 * makes its own, so nothing can be served stale.
 */
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
let calls: { wallet: string }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ wallet: body.walletAddress });
    return new Response(JSON.stringify({ history: [{ at: calls.length, wallet: body.walletAddress }] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const mod = () => import("@/lib/hooks/historyFetch");

describe("fetchHistory", () => {
  it("identical calls in the same tick share one request", async () => {
    const { fetchHistory } = await mod();
    const [x, y] = await Promise.all([fetchHistory(A), fetchHistory(A)]);
    expect(calls).toHaveLength(1);
    expect(x.history).toEqual(y.history);
  });
  it("case differences in the address still share it", async () => {
    const { fetchHistory } = await mod();
    await Promise.all([fetchHistory(A), fetchHistory(A.toUpperCase().replace("0X", "0x"))]);
    expect(calls).toHaveLength(1);
  });
  it("a different wallet is a different request", async () => {
    const { fetchHistory } = await mod();
    await Promise.all([fetchHistory(A), fetchHistory(B)]);
    expect(calls.map((c) => c.wallet).sort()).toEqual([A, B]);
  });
  it("a call from a later tick is never served from an earlier one", async () => {
    const { fetchHistory } = await mod();
    const first = await fetchHistory(A);
    await new Promise((r) => setTimeout(r, 0));
    const second = await fetchHistory(A);
    expect(calls).toHaveLength(2);
    expect(second.history).not.toEqual(first.history);
  });
  it("no wallet is sent as null (the server answers with nothing, as before)", async () => {
    const { fetchHistory } = await mod();
    await fetchHistory(null);
    expect(calls[0].wallet).toBeNull();
  });
  it("a failed request fails every sharer, and the next call starts fresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { fetchHistory } = await mod();
    const r = await Promise.allSettled([fetchHistory(A), fetchHistory(A)]);
    expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    await new Promise((res) => setTimeout(res, 0));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ history: [] }), { status: 200 })));
    await expect(fetchHistory(A)).resolves.toMatchObject({ history: [] });
  });
});

describe("the sync-driven surfaces use it", () => {
  const code = (p: string) => readFileSync(join(__dirname, "..", p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it.each(["lib/hooks/useNotifications.ts", "app/dashboard/page.tsx", "lib/hooks/useActivity.ts"])("%s", (f) => {
    const src = code(f);
    expect(src).toMatch(/fetchHistory\(/);
    expect(src).not.toMatch(/Show my transaction history/);
  });
});
