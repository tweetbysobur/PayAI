import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteNeedsReview, approvalHint } from "@/lib/plans-client/approval";

vi.mock("@/lib/monad/browserClient", () => ({
  getBrowserPublicClient: async () => ({
    getBalance: async () => 10n ** 20n,
    estimateGas: async () => 21000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1n }),
  }),
}));
vi.mock("@/lib/auth/ensureWalletGrant", () => ({ ensureWalletGrant: async () => {} }));

const ADDR = "0x0264538C189FdFccFe233Fb1413e444f81638F7f" as const;

function fakeWallet() {
  const ended = { value: false };
  return {
    ended,
    wallet: {
      address: ADDR, credentialId: "c",
      account: {} as never,
      session: { end: () => { ended.value = true; } } as never,
    },
  };
}

describe("quoteNeedsReview", () => {
  it("lets a clean, low-risk quote go straight on", () => {
    expect(quoteNeedsReview({})).toBe(false);
    expect(quoteNeedsReview({ warnings: [], risk: { score: 1, level: "low", compliance: "approved" } })).toBe(false);
  });
  it("stops on any warning", () => {
    expect(quoteNeedsReview({ warnings: ["High price impact"] })).toBe(true);
  });
  it("stops on medium or high risk", () => {
    expect(quoteNeedsReview({ risk: { score: 50, level: "medium", compliance: "approved" } })).toBe(true);
    expect(quoteNeedsReview({ risk: { score: 90, level: "high", compliance: "approved" } })).toBe(true);
  });
});

describe("approvalHint", () => {
  it("says one passkey approval for the PayAI Wallet", () => {
    expect(approvalHint(true, true)).toMatch(/One passkey approval runs every action/);
  });
  it("is honest that an external wallet confirms each transaction", () => {
    expect(approvalHint(true, false)).toMatch(/your wallet confirms each transaction/);
  });
});

describe("openApprovalSession — one passkey prompt, bounded", () => {
  beforeEach(() => { vi.useRealTimers(); });

  it("prompts once and signs several transactions with it", async () => {
    const { openApprovalSession } = await import("@/lib/wallet-service/registry");
    const { wallet } = fakeWallet();
    const authorize = vi.fn(async () => wallet as never);
    const send = vi.fn(async () => "0xhash");
    const s = await openApprovalSession(ADDR, { maxTransactions: 3, ttlMs: 60_000 }, send, authorize);
    await s.sendTransaction({ to: ADDR, value: "1" });
    await s.sendTransaction({ to: ADDR, value: "1" });
    await s.sendTransaction({ to: ADDR, value: "1" });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
    s.end();
  });

  it("refuses past its transaction limit", async () => {
    const { openApprovalSession } = await import("@/lib/wallet-service/registry");
    const { wallet } = fakeWallet();
    const send = vi.fn(async () => "0xhash");
    const s = await openApprovalSession(ADDR, { maxTransactions: 1, ttlMs: 60_000 }, send, async () => wallet as never);
    await s.sendTransaction({ to: ADDR });
    await expect(s.sendTransaction({ to: ADDR })).rejects.toThrow(/no more transactions/);
    expect(send).toHaveBeenCalledTimes(1);
    s.end();
  });

  it("refuses after it expires, and zeroes the key", async () => {
    const { openApprovalSession } = await import("@/lib/wallet-service/registry");
    const { wallet, ended } = fakeWallet();
    let t = 1_000;
    const send = vi.fn(async () => "0xhash");
    const s = await openApprovalSession(ADDR, { maxTransactions: 5, ttlMs: 1_000 }, send, async () => wallet as never, () => t);
    t = 2_500;
    await expect(s.sendTransaction({ to: ADDR })).rejects.toThrow(/expired/);
    expect(send).not.toHaveBeenCalled();
    expect(ended.value).toBe(true);
  });

  it("refuses after end(), and end() zeroes the key", async () => {
    const { openApprovalSession } = await import("@/lib/wallet-service/registry");
    const { wallet, ended } = fakeWallet();
    const send = vi.fn(async () => "0xhash");
    const s = await openApprovalSession(ADDR, { maxTransactions: 5, ttlMs: 60_000 }, send, async () => wallet as never);
    s.end();
    expect(ended.value).toBe(true);
    await expect(s.sendTransaction({ to: ADDR })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("caps the limits a caller can ask for", async () => {
    const { openApprovalSession, APPROVAL_SESSION_MAX_TRANSACTIONS } = await import("@/lib/wallet-service/registry");
    const { wallet } = fakeWallet();
    const send = vi.fn(async () => "0xhash");
    const s = await openApprovalSession(ADDR, { maxTransactions: 10_000, ttlMs: 60_000 }, send, async () => wallet as never);
    for (let i = 0; i < APPROVAL_SESSION_MAX_TRANSACTIONS; i++) await s.sendTransaction({ to: ADDR });
    await expect(s.sendTransaction({ to: ADDR })).rejects.toThrow(/no more transactions/);
    s.end();
  });

  it("a cancelled passkey prompt opens nothing", async () => {
    const { openApprovalSession } = await import("@/lib/wallet-service/registry");
    await expect(openApprovalSession(ADDR, { maxTransactions: 2, ttlMs: 60_000 }, vi.fn(), async () => { throw new Error("cancelled"); }))
      .rejects.toThrow();
  });
});

describe("the plan card uses it", () => {
  const src = readFileSync(join(__dirname, "..", "components/ask/PlanCard.tsx"), "utf8");
  it("opens the approval from the Approve tap, before approving the plan", () => {
    const body = src.slice(src.indexOf("async function approveAndRun"));
    expect(body.indexOf("openSession()")).toBeGreaterThan(-1);
    expect(body.indexOf("openSession()")).toBeLessThan(body.indexOf("approvePlan(planId)"));
  });
  it("always ends the session when the run finishes", () => {
    const run = src.slice(src.indexOf("async function run("), src.indexOf("async function approveAndRun"));
    expect(run).toMatch(/finally \{[\s\S]*session\?\.end\(\)/);
  });
  it("still shows a flagged quote", () => {
    expect(src).toMatch(/quoteNeedsReview\(q\) === false/);
  });
});
