import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * app/api/telegram/webhook/route.ts is the entry point for every command a
 * Telegram user can send — its own job is auth, dedupe, rate limiting, and
 * dispatch, NOT trading logic (that's lib/telegram/tradeRunner.ts, covered
 * in test/telegram-trade-runner.test.ts). These tests exercise the route
 * with real idempotency/ratelimit modules (in-memory fallback -- no KV
 * configured in tests) so the dedupe/rate-limit guarantees are proven
 * against the actual production code path, not a mock of it, while the
 * command handlers themselves are mocked so no real chain/RPC calls happen.
 */

const SECRET = "webhook-secret";
process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;

let dispatchCalls: { command: string; args: string[]; telegramUserId: string }[] = [];
let dispatchImpl: (command: string, ctx: { telegramUserId: string; args: string[] }) => Promise<string | null> = async () => "ok";

vi.mock("@/lib/telegram/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telegram/commands")>();
  return {
    ...actual,
    dispatchCommand: async (command: string, ctx: { telegramUserId: string; args: string[] }) => {
      dispatchCalls.push({ command, args: ctx.args, telegramUserId: ctx.telegramUserId });
      return dispatchImpl(command, ctx);
    },
  };
});

const sentMessages: { chatId: number | string; text: string }[] = [];
vi.mock("@/lib/telegram/send", () => ({
  sendTelegramMessage: async (chatId: number | string, text: string) => {
    sentMessages.push({ chatId, text });
  },
}));

function makeReq(body: unknown, headers: Record<string, string> = { "x-telegram-bot-api-secret-token": SECRET }) {
  return new NextRequest("https://usepayai.xyz/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function updateFor(updateId: number, text: string, opts: { userId?: number; chatId?: number } = {}) {
  return {
    update_id: updateId,
    message: { from: { id: opts.userId ?? 111 }, chat: { id: opts.chatId ?? 111 }, text },
  };
}

afterEach(() => {
  dispatchCalls = [];
  dispatchImpl = async () => "ok";
  sentMessages.length = 0;
  const g = globalThis as unknown as { __veripayRL?: Map<string, unknown>; __veripayIdem?: Map<string, unknown> };
  g.__veripayRL?.clear();
  g.__veripayIdem?.clear();
});

describe("POST /api/telegram/webhook — auth gate", () => {
  it("rejects a request with no secret header, and never dispatches anything", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route");
    const res = await POST(makeReq(updateFor(1, "/start"), {}));
    expect(res.status).toBe(401);
    expect(dispatchCalls).toHaveLength(0);
  });

  it("rejects a request with the wrong secret", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route");
    const res = await POST(makeReq(updateFor(2, "/start"), { "x-telegram-bot-api-secret-token": "wrong" }));
    expect(res.status).toBe(401);
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe("POST /api/telegram/webhook — dispatch and reply", () => {
  it("parses the command and args, dispatches once, and sends the reply back to the right chat", async () => {
    dispatchImpl = async () => "Welcome!";
    const { POST } = await import("@/app/api/telegram/webhook/route");
    const res = await POST(makeReq(updateFor(10, "/buy 0xaaaabbbbccccddddeeeeffff0000111122223333 1.5", { userId: 42, chatId: 999 })));
    expect(res.status).toBe(200);
    expect(dispatchCalls).toEqual([{ command: "/buy", args: ["0xaaaabbbbccccddddeeeeffff0000111122223333", "1.5"], telegramUserId: "42" }]);
    expect(sentMessages).toEqual([{ chatId: 999, text: "Welcome!" }]);
  });

  it("a non-text update (no message.text) is silently ignored -- no dispatch, no reply", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route");
    const res = await POST(makeReq({ update_id: 11, message: { from: { id: 1 }, chat: { id: 1 } } }));
    expect(res.status).toBe(200);
    expect(dispatchCalls).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  it("an unrecognized command returns null from dispatch and sends no reply", async () => {
    dispatchImpl = async () => null;
    const { POST } = await import("@/app/api/telegram/webhook/route");
    await POST(makeReq(updateFor(12, "/notacommand")));
    expect(sentMessages).toHaveLength(0);
  });
});

describe("POST /api/telegram/webhook — duplicate update_id never executes a command twice", () => {
  it("the SAME update_id delivered twice (a Telegram retry) only dispatches once", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route");
    const update = updateFor(777, "/buy 0xaaaabbbbccccddddeeeeffff0000111122223333 1");
    const first = await POST(makeReq(update));
    const second = await POST(makeReq(update)); // identical update_id -- a real Telegram retry
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(dispatchCalls).toHaveLength(1);
  });

  it("two DIFFERENT update_ids from the same user both dispatch -- dedupe is per-update, not per-user", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route");
    await POST(makeReq(updateFor(1001, "/balance")));
    await POST(makeReq(updateFor(1002, "/balance")));
    expect(dispatchCalls).toHaveLength(2);
  });
});

describe("POST /api/telegram/webhook — per-user rate limiting", () => {
  it("a burst of commands from one Telegram user beyond the limit stops dispatching and warns instead", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route");
    const userId = 5050;
    let lastRes;
    for (let i = 0; i < 15; i++) {
      lastRes = await POST(makeReq(updateFor(2000 + i, "/balance", { userId })));
    }
    expect(lastRes!.status).toBe(200); // still 200 -- Telegram never sees an error status
    expect(dispatchCalls.length).toBeLessThan(15); // some were throttled before reaching dispatch
    expect(sentMessages.some((m) => /too fast/i.test(m.text))).toBe(true);
  });

  it("a different Telegram user is not affected by another user's rate limit", async () => {
    const { POST } = await import("@/app/api/telegram/webhook/route");
    for (let i = 0; i < 15; i++) {
      await POST(makeReq(updateFor(3000 + i, "/balance", { userId: 6060 })));
    }
    dispatchCalls.length = 0; // reset the count for a clean read on the second user
    const res = await POST(makeReq(updateFor(4000, "/balance", { userId: 7070 })));
    expect(res.status).toBe(200);
    expect(dispatchCalls).toHaveLength(1);
  });
});
