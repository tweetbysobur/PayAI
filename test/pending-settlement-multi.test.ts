import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A broadcast transaction whose confirm step hasn't finished is the
 * highest-consequence state in the app (lib/hooks/pendingSettlement.ts). The
 * store held ONE record: a second broadcast (another payment, or another
 * wallet) silently erased the first, and clearing one payment's record erased
 * whatever else was waiting. Each pending transaction now has its own record,
 * keyed by its hash, and is removed only by its own definitive outcome.
 */
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const H1 = `0x${"a1".repeat(32)}`;
const H2 = `0x${"b2".repeat(32)}`;
const H3 = `0x${"c3".repeat(32)}`;

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.resetModules();
});
const mod = () => import("@/lib/hooks/pendingSettlement");
const rec = (walletAddress: string, txHash: string, savedAt = Date.now()) => ({ kind: "payment" as const, walletAddress, txHash, rawText: "send", requestId: "r", savedAt });

describe("pending settlements", () => {
  it("a second broadcast does not erase the first (same wallet)", async () => {
    const m = await mod();
    m.savePendingSettlement(rec(A, H1, 1));
    m.savePendingSettlement(rec(A, H2, 2));
    expect(m.getPendingSettlement(A)?.txHash).toBe(H1); // oldest first
    m.clearPendingSettlement(H1);
    expect(m.getPendingSettlement(A)?.txHash).toBe(H2); // the second survived
    m.clearPendingSettlement(H2);
    expect(m.getPendingSettlement(A)).toBeNull();
  });

  it("another wallet's broadcast does not erase this wallet's", async () => {
    const m = await mod();
    m.savePendingSettlement(rec(A, H1));
    m.savePendingSettlement(rec(B, H2));
    expect(m.getPendingSettlement(A)?.txHash).toBe(H1);
    expect(m.getPendingSettlement(B)?.txHash).toBe(H2);
  });

  it("clearing one hash leaves every other record", async () => {
    const m = await mod();
    m.savePendingSettlement(rec(A, H1, 1));
    m.savePendingSettlement(rec(A, H2, 2));
    m.savePendingSettlement(rec(A, H3, 3));
    m.clearPendingSettlement(H2);
    expect(m.getPendingSettlement(A)?.txHash).toBe(H1);
    m.clearPendingSettlement(H1);
    expect(m.getPendingSettlement(A)?.txHash).toBe(H3);
  });

  it("clearing a hash that isn't stored changes nothing", async () => {
    const m = await mod();
    m.savePendingSettlement(rec(A, H1));
    m.clearPendingSettlement(H3);
    expect(m.getPendingSettlement(A)?.txHash).toBe(H1);
  });

  it("saving the same hash again replaces its record, never duplicates it", async () => {
    const m = await mod();
    m.savePendingSettlement(rec(A, H1, 1));
    m.savePendingSettlement({ ...rec(A, H1, 2), requestId: "newer" });
    expect(m.getPendingSettlement(A)?.requestId).toBe("newer");
    m.clearPendingSettlement(H1);
    expect(m.getPendingSettlement(A)).toBeNull();
  });

  it("hash matching ignores case", async () => {
    const m = await mod();
    m.savePendingSettlement(rec(A, H1));
    m.clearPendingSettlement(H1.toUpperCase().replace("0X", "0x"));
    expect(m.getPendingSettlement(A)).toBeNull();
  });

  it("the primary key still holds a single record object (what existing readers expect)", async () => {
    const m = await mod();
    m.savePendingSettlement(rec(A, H1));
    m.savePendingSettlement(rec(A, H2));
    const primary = JSON.parse(store.get("payai_pending_settlement")!);
    expect(primary.txHash).toBe(H1);
    expect(Array.isArray(primary)).toBe(false);
  });

  it("a record written by the old code (one object, no queue) is read and cleared as before", async () => {
    store.set("payai_pending_settlement", JSON.stringify(rec(A, H1)));
    const m = await mod();
    expect(m.getPendingSettlement(A)?.txHash).toBe(H1);
    m.clearPendingSettlement(H1);
    expect(m.getPendingSettlement(A)).toBeNull();
  });

  it("corrupt storage reads as nothing and never throws", async () => {
    store.set("payai_pending_settlement", "{not json");
    store.set("payai_pending_settlement_queue", "also not json");
    const m = await mod();
    expect(m.getPendingSettlement(A)).toBeNull();
    expect(() => m.savePendingSettlement(rec(A, H1))).not.toThrow();
    expect(m.getPendingSettlement(A)?.txHash).toBe(H1);
  });

  it("no-argument clear keeps its old meaning for callers that have no hash: the primary record", async () => {
    const m = await mod();
    m.savePendingSettlement(rec(A, H1));
    m.clearPendingSettlement();
    expect(m.getPendingSettlement(A)).toBeNull();
  });
});

describe("every settlement outcome clears only its own transaction", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it.each([
    ["lib/ask/sendPayment/orchestrator.ts"],
    ["lib/ask/intent/orchestrate.ts"],
    ["lib/hooks/useAgentConsole.ts"],
  ])("%s never calls clearPendingSettlement() without a hash", (file) => {
    const src = strip(readFileSync(join(__dirname, "..", file), "utf8"));
    expect(src).not.toMatch(/clearPendingSettlement\(\s*\)/);
    expect(src).toMatch(/clearPendingSettlement\(\s*[A-Za-z_.]+\s*\)/);
  });
});
