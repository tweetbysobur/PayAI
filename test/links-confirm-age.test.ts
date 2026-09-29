import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * An invoice is paid by a transfer made FOR it — not by any older transfer
 * that happens to have reached the same wallet.
 *
 * The confirm route checked token, recipient and amount but not when the
 * transfer happened. A link's recipient is the creator's wallet, whose past
 * incoming transfers are public on any explorer, so anyone could present an
 * old one (never used for another invoice) and mark the invoice paid — and
 * book it as revenue — without paying anything.
 */
const USDC = "0xaC0893567D43C3E7e6e35a72803df05416C1f20D"; // testnet default in lib/monad/config.ts
const CREATOR = "0x3333333333333333333333333333333333333333";
const PAYER = "0x5555555555555555555555555555555555555555";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

let blockTimestampSec = 0n;
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: async () => ({
        status: "success",
        from: PAYER,
        blockNumber: 123n,
        logs: [{
          address: USDC,
          topics: [TRANSFER_TOPIC, pad(PAYER), pad(CREATOR)],
          data: `0x${(12_000_000n).toString(16)}`,
        }],
      }),
      getBlock: async () => ({ timestamp: blockTimestampSec }),
    }),
  };
});

describe("POST /api/links/[id]/confirm — transfer age", () => {
  let savedNet: string | undefined;
  beforeEach(() => {
    savedNet = process.env.MONAD_NETWORK;
    process.env.MONAD_NETWORK = "testnet";
    const g = globalThis as unknown as { __veripayRL?: Map<string, unknown> };
    g.__veripayRL?.clear();
  });
  afterEach(() => {
    if (savedNet === undefined) delete process.env.MONAD_NETWORK;
    else process.env.MONAD_NETWORK = savedNet;
  });

  async function confirm(txHash: string) {
    const { createLink } = await import("@/lib/platform/store");
    const link = await createLink("demo", { amount: 12, token: "USDC", recipient: CREATOR, sender: CREATOR });
    const { POST } = await import("@/app/api/links/[id]/confirm/route");
    const res = await POST(
      new NextRequest(`https://usepayai.xyz/api/links/${link.id}/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash }),
      }),
      { params: Promise.resolve({ id: link.id }) },
    );
    return { res, link };
  }

  it("refuses a transfer mined before the invoice existed", async () => {
    blockTimestampSec = BigInt(Math.floor((Date.now() - 30 * 86_400_000) / 1000)); // a month old
    const { res } = await confirm(`0x${"a1".repeat(32)}`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/before this invoice/);
  });

  it("accepts a transfer mined after the invoice was created", async () => {
    blockTimestampSec = BigInt(Math.floor(Date.now() / 1000) + 5);
    const { res } = await confirm(`0x${"b2".repeat(32)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).link.status).toBe("paid");
  });
});
