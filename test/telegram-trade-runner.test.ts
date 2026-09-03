import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/telegram/tradeRunner.ts is the one place a Telegram user's custodial
 * key actually gets used to move funds. Two things matter more than
 * anything else here:
 *   1. Signing genuinely uses the per-Telegram-user account this call was
 *      given — never any other account. There is no MONAD_AGENT_PRIVATE_KEY
 *      in scope anywhere in this file (it never imports getWalletClient or
 *      getAgentAccount from lib/monad/wallet — only getPublicClient, a
 *      read-only client) — these tests prove that at the call-site level:
 *      whatever account object is passed in is exactly what reaches
 *      sendTransaction.
 *   2. A route the quoting layer refuses (no liquidity, price impact too
 *      high, anything previewTrade/prepareTradeExecution already reject)
 *      must never reach the signing step at all -- there is no bot-side
 *      override of that refusal.
 */

const sentTx: { account?: unknown; to?: string; data?: string; value?: bigint }[] = [];
let receiptStatus: "success" | "reverted" = "success";

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createWalletClient: () => ({
      sendTransaction: async (args: { account: unknown; to: string; data: string; value: bigint }) => {
        sentTx.push(args);
        return "0xabc0000000000000000000000000000000000000000000000000000000000abc" as `0x${string}`;
      },
    }),
  };
});

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    waitForTransactionReceipt: async () => ({ status: receiptStatus }),
  }),
}));

vi.mock("@/lib/monad/config", () => ({
  getChain: () => ({ id: 1, name: "Monad" }),
  getTransport: () => ({}),
  explorerTx: (hash: string) => `https://monadexplorer.com/tx/${hash}`,
}));

type PrepareResult =
  | { ok: true; status: "ready"; preview: { spend: { amount: string; token: string }; receive: { amount: string; token: string }; route: { provider: string } }; steps: { kind: string; label: string; tx: { to: string; data: string; value: string }; settleLeg?: Record<string, unknown> }[] }
  | { ok: true; status: "changed" }
  | { ok: false; message: string };

let prepareResult: PrepareResult = { ok: false, message: "not configured" };
vi.mock("@/lib/monad/tradeQuote", () => ({
  prepareTradeExecution: async () => prepareResult,
}));

const originalFetch = global.fetch;
afterEach(() => {
  sentTx.length = 0;
  receiptStatus = "success";
  prepareResult = { ok: false, message: "not configured" };
  global.fetch = originalFetch;
});

function fakeAccount(address: string) {
  return { address, type: "local" } as unknown as Parameters<typeof import("@/lib/telegram/tradeRunner").runTrade>[0];
}

describe("runTrade — signs with the account it was given, never any other", () => {
  it("sendTransaction is called with EXACTLY the per-user account passed to runTrade", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const account = fakeAccount("0x1111111111111111111111111111111111111a");
    prepareResult = {
      ok: true, status: "ready",
      preview: { spend: { amount: "1", token: "MON" }, receive: { amount: "2", token: "PEPE" }, route: { provider: "Uniswap v3" } },
      steps: [{ kind: "swap", label: "Swap", tx: { to: "0x2222222222222222222222222222222222222b", data: "0xdead", value: "0" }, settleLeg: { fromToken: "MON", toToken: "PEPE", amountIn: 1, amountOut: 2, provider: "Uniswap v3" } }],
    };
    const { runTrade } = await import("@/lib/telegram/tradeRunner");
    const result = await runTrade(account, { action: "buy", inputToken: "MON", outputToken: "PEPE", amount: "1", amountType: "exact_input" });
    expect(result.ok).toBe(true);
    expect(sentTx).toHaveLength(1);
    expect(sentTx[0].account).toBe(account);
  });

  it("posts the settlement call with feature: 'trade' and the account's own address as walletAddress", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    global.fetch = vi.fn(async (_url, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const account = fakeAccount("0x3333333333333333333333333333333333333c");
    prepareResult = {
      ok: true, status: "ready",
      preview: { spend: { amount: "1", token: "MON" }, receive: { amount: "2", token: "PEPE" }, route: { provider: "Uniswap v3" } },
      steps: [{ kind: "swap", label: "Swap", tx: { to: "0x2222222222222222222222222222222222222b", data: "0xdead", value: "0" }, settleLeg: { fromToken: "MON", toToken: "PEPE", amountIn: 1, amountOut: 2, provider: "Uniswap v3" } }],
    };
    const { runTrade } = await import("@/lib/telegram/tradeRunner");
    await runTrade(account, { action: "buy", inputToken: "MON", outputToken: "PEPE", amount: "1", amountType: "exact_input" });
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.feature).toBe("trade");
    expect(capturedBody!.walletAddress).toBe(account.address);
  });
});

describe("runTrade — a route the quoting layer refuses never reaches the signing step", () => {
  it("prepareTradeExecution's own ok:false is returned as-is, and sendTransaction is never called", async () => {
    prepareResult = { ok: false, message: "No usable trading route found for MON → SCAM right now." };
    const account = fakeAccount("0x4444444444444444444444444444444444444d");
    const { runTrade } = await import("@/lib/telegram/tradeRunner");
    const result = await runTrade(account, { action: "buy", inputToken: "MON", outputToken: "SCAM", amount: "1", amountType: "exact_input" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("No usable trading route found");
    expect(sentTx).toHaveLength(0);
  });

  it("a 'changed' quote (moved since preview) is refused rather than executed against stale numbers", async () => {
    prepareResult = { ok: true, status: "changed" };
    const account = fakeAccount("0x5555555555555555555555555555555555555e");
    const { runTrade } = await import("@/lib/telegram/tradeRunner");
    const result = await runTrade(account, { action: "buy", inputToken: "MON", outputToken: "PEPE", amount: "1", amountType: "exact_input" });
    expect(result.ok).toBe(false);
    expect(sentTx).toHaveLength(0);
  });

  it("a step that reverts on-chain is reported honestly, and settlement is never posted for it", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    receiptStatus = "reverted";
    prepareResult = {
      ok: true, status: "ready",
      preview: { spend: { amount: "1", token: "MON" }, receive: { amount: "2", token: "PEPE" }, route: { provider: "Uniswap v3" } },
      steps: [{ kind: "swap", label: "Swap", tx: { to: "0x2222222222222222222222222222222222222b", data: "0xdead", value: "0" }, settleLeg: { fromToken: "MON", toToken: "PEPE", amountIn: 1, amountOut: 2, provider: "Uniswap v3" } }],
    };
    const account = fakeAccount("0x6666666666666666666666666666666666666f");
    const { runTrade } = await import("@/lib/telegram/tradeRunner");
    const result = await runTrade(account, { action: "buy", inputToken: "MON", outputToken: "PEPE", amount: "1", amountType: "exact_input" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toMatch(/reverted/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
