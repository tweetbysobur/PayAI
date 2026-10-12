import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import QRCode from "qrcode";
import sharp from "sharp";

/**
 * POST /api/ask/visual with the grant, rate limit and model mocked. Covers
 * auth, upload limits, partial and total processing failures, and that the
 * route only ever returns a reading — never an operation.
 */

const state = vi.hoisted(() => ({ wallet: "0x1111111111111111111111111111111111111111" as string | null, limited: false, vision: "ok" as "ok" | "throw" | "off" }));

vi.mock("@/lib/plan/http", () => ({ planAuthFrom: () => (state.wallet ? { wallet: state.wallet } : null) }));
vi.mock("@/lib/platform/ratelimit", () => ({
  rateLimited: async () => (state.limited ? new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }) : null),
}));
vi.mock("@/lib/ask/visual/server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ask/visual/server")>();
  return {
    ...actual,
    extractFromImage: async () => {
      if (state.vision === "throw") throw new Error("model down");
      if (state.vision === "off") return null;
      return { kind: "payment_instruction", actions: [{ type: "send", amount: "25", token: "USDC", toToken: null, recipient: "alice.nad", amountFromPrevious: false }], addresses: [], invoice: null, suspicious: false };
    },
  };
});

const ADDR = "0x52908400098527886E0F7030069857D2E4169EE7";

async function post(body: FormData | null, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/ask/visual/route");
  const req = new NextRequest("http://localhost/api/ask/visual", { method: "POST", body: body ?? undefined, headers });
  const res = await POST(req);
  return { status: res.status, json: await res.json(), headers: res.headers };
}

const form = (bytes: Uint8Array | Buffer, caption?: string) => {
  const f = new FormData();
  f.append("image", new Blob([new Uint8Array(bytes)]), "x");
  if (caption !== undefined) f.append("caption", caption);
  return f;
};
const plainPng = () => sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } }).png().toBuffer();

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.wallet = "0x1111111111111111111111111111111111111111"; state.limited = false; state.vision = "ok";
  process.env.MONAD_NETWORK = "mainnet";
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe("POST /api/ask/visual", () => {
  it("requires an unlocked wallet", async () => {
    state.wallet = null;
    const r = await post(form(await plainPng()));
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("wallet_grant_required");
  });

  it("is rate limited", async () => {
    state.limited = true;
    expect((await post(form(await plainPng()))).status).toBe(429);
  });

  it("rejects a missing file, an unsupported format and an oversized upload", async () => {
    expect((await post(new FormData())).status).toBe(400);
    expect((await post(form(Buffer.from("GIF89a.........")))).status).toBe(415);
    expect((await post(form(Buffer.from("<svg onload=alert(1)>")))).status).toBe(415);
    const big = new Uint8Array(4 * 1024 * 1024 + 10); big.set([0xff, 0xd8, 0xff]);
    expect((await post(form(big))).status).toBe(413);
  });

  it("rejects a file that only pretends to be an image", async () => {
    const r = await post(form(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])));
    expect(r.status).toBe(415);
    expect(r.json.code).toBe("undecodable");
  });

  it("an image with an instruction → a request sentence, never an operation", async () => {
    const r = await post(form(await plainPng()));
    expect(r.status).toBe(200);
    expect(r.json.resolution).toMatchObject({ kind: "intent", text: "Send 25 USDC to alice.nad" });
    expect(JSON.stringify(r.json)).not.toMatch(/operation|txHash|planId|signature/);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("a QR code + caption works even when the vision model fails (partial)", async () => {
    state.vision = "throw";
    const qr = await QRCode.toBuffer(ADDR, { type: "png", width: 400 });
    const r = await post(form(qr, "Send 5 USDC to this address"));
    expect(r.status).toBe(200);
    expect(r.json.partial).toBe(true);
    expect(r.json.resolution).toMatchObject({ kind: "intent", text: `Send 5 USDC to ${ADDR}` });
  });

  it("nothing readable and the model failing → a retryable error", async () => {
    state.vision = "throw";
    const r = await post(form(await plainPng()));
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ code: "processing_failed", retryable: true });
  });

  it("no QR and no model configured → says so", async () => {
    state.vision = "off";
    const r = await post(form(await plainPng()));
    expect(r.status).toBe(422);
  });

  it("rejects an over-long caption", async () => {
    expect((await post(form(await plainPng(), "x".repeat(600)))).status).toBe(400);
  });

  it("duplicate submissions only read twice — nothing is created", async () => {
    const qr = await QRCode.toBuffer(ADDR, { type: "png", width: 400 });
    const a = await post(form(qr, "Send 5 USDC to this address"));
    const b = await post(form(qr, "Send 5 USDC to this address"));
    expect(a.json.resolution).toEqual(b.json.resolution);
  });

  it("logs only the outcome, never the image, QR payload or extracted values", async () => {
    const qr = await QRCode.toBuffer(ADDR, { type: "png", width: 400 });
    await post(form(qr, "Send 5 USDC to this address"));
    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/\[AskVisual\]/);
    expect(logged).not.toContain(ADDR);
    expect(logged).not.toMatch(/alice\.nad|Send 5/);
  });
});
