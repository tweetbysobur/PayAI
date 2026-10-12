import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import sharp from "sharp";
import { checkUpload, MAX_IMAGE_BYTES, sniffImageType } from "@/lib/ask/visual/upload";
import { parseQrPayload } from "@/lib/ask/visual/qrPayload";
import {
  applyVisualAddress, readCaption, resolveVisualIntent,
  type ExtractedAction, type ImageExtraction, type VisualResolution,
} from "@/lib/ask/visual/resolve";
import { checkDecodable, coerceExtraction, decodeQr, extractFromImage, type VisionClient } from "@/lib/ask/visual/server";
import { parseIntent } from "@/lib/plan-adapter/grammar";
import { toPlanText, matchPlanRequest } from "@/lib/ask/planFastPath";

/**
 * Visual intent input (Ask PayAI): upload rules, the dedicated QR decoder,
 * QR payload validation, the vision reading's coercion, and the resolver that
 * merges image + QR + caption into a request sentence or a question. The
 * sentence is then checked against the REAL plan grammar — the same intake a
 * typed request goes through. No model, network or wallet is used.
 */

const CHAIN = 143; // Monad mainnet
const ADDR = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55 test vector
const ADDR2 = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const TOKENS = { monDecimals: 18, stable: { symbol: "USDC", decimals: 6 } };

const send = (p: Partial<ExtractedAction>): ExtractedAction =>
  ({ type: "send", amount: null, token: null, toToken: null, recipient: null, amountFromPrevious: false, ...p });
const reading = (p: Partial<ImageExtraction>): ImageExtraction =>
  ({ kind: "payment_instruction", actions: [], addresses: [], invoice: null, suspicious: false, ...p });
const qrOf = (raw: string) => parseQrPayload(raw, CHAIN);
const textOf = (r: VisualResolution) => (r.kind === "intent" ? r.text : r.reply);

const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ["MONAD_NETWORK", "MONAD_MAINNET_USDC"]) saved[k] = process.env[k];
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests(); __resetBootstrapForTests(); ensureBuiltinsRegistered();
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

/** A request sentence must be accepted by the plan grammar Ask uses. */
function plans(text: string, actions: number) {
  expect(matchPlanRequest(toPlanText(text)), text).not.toBeNull();
  const r = parseIntent(toPlanText(text), TOKENS);
  expect(r.ok, `${text} → ${r.ok ? "" : r.code}`).toBe(true);
  if (r.ok) expect(r.steps).toHaveLength(actions);
}

async function qrPng(text: string): Promise<Uint8Array> {
  return new Uint8Array(await QRCode.toBuffer(text, { type: "png", margin: 4, width: 400 }));
}

describe("upload validation", () => {
  it("decides the type from the bytes, not the name", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer());
    const jpg = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).jpeg().toBuffer());
    const webp = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).webp().toBuffer());
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(jpg)).toBe("image/jpeg");
    expect(sniffImageType(webp)).toBe("image/webp");
  });
  it("rejects empty, oversized and unsupported files", async () => {
    expect(checkUpload(new Uint8Array())).toMatchObject({ ok: false, code: "empty" });
    expect(checkUpload(new Uint8Array(MAX_IMAGE_BYTES + 1))).toMatchObject({ ok: false, code: "too_large" });
    const gif = new Uint8Array(Buffer.from("GIF89a....."));
    expect(checkUpload(gif)).toMatchObject({ ok: false, code: "unsupported_type" });
    const pdf = new Uint8Array(Buffer.from("%PDF-1.7 ....."));
    expect(checkUpload(pdf)).toMatchObject({ ok: false, code: "unsupported_type" });
    const html = new Uint8Array(Buffer.from("<script>alert(1)</script>"));
    expect(checkUpload(html)).toMatchObject({ ok: false, code: "unsupported_type" });
  });
  it("a file with image magic bytes but a broken body fails decoding", async () => {
    const fake = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
    expect(checkUpload(fake).ok).toBe(true);
    await expect(checkDecodable(fake)).rejects.toThrow();
  });
});

describe("QR decoding (dedicated decoder, not the vision model)", () => {
  it("reads an address from a real QR image", async () => {
    expect(await decodeQr(await qrPng(ADDR))).toBe(ADDR);
  });
  it("reads an EIP-681 request from a real QR image", async () => {
    const uri = `ethereum:${ADDR}@${CHAIN}?value=2.5e18`;
    expect(await decodeQr(await qrPng(uri))).toBe(uri);
  });
  it("returns null for an image without a QR code", async () => {
    const plain = new Uint8Array(await sharp({ create: { width: 200, height: 200, channels: 3, background: "#888" } }).png().toBuffer());
    expect(await decodeQr(plain)).toBeNull();
  });
  it("a damaged QR code doesn't decode to a wrong value", async () => {
    const png = await qrPng(ADDR);
    const damaged = await sharp(png).composite([{ input: { create: { width: 260, height: 260, channels: 3, background: "#000" } }, left: 70, top: 70 }]).png().toBuffer();
    const out = await decodeQr(new Uint8Array(damaged));
    expect(out === null || out === ADDR).toBe(true);
  });
});

describe("QR payload validation (untrusted input)", () => {
  it("accepts a plain address and normalises its checksum", () => {
    expect(qrOf(ADDR.toLowerCase())).toMatchObject({ ok: true, recipient: ADDR, format: "address" });
  });
  it("refuses an address with a broken checksum", () => {
    const bad = ADDR.slice(0, -1) + "e"; // flips one checksummed letter's case
    expect(qrOf(bad)).toMatchObject({ ok: false });
  });
  it("accepts a .nad name", () => {
    expect(qrOf("alice.nad")).toMatchObject({ ok: true, recipient: "alice.nad", format: "nad" });
  });
  it("reads an EIP-681 native request with amount", () => {
    expect(qrOf(`ethereum:${ADDR}@${CHAIN}?value=2500000000000000000`)).toMatchObject({ ok: true, recipient: ADDR, amount: "2.5", token: "MON" });
  });
  it("reads an EIP-681 token transfer but never guesses the raw amount", () => {
    const r = qrOf(`ethereum:${USDC}@${CHAIN}/transfer?address=${ADDR}&uint256=5000000`);
    expect(r).toMatchObject({ ok: true, recipient: ADDR, rawTokenAmount: "5000000" });
    expect(r.ok && r.amount).toBeFalsy();
  });
  it("refuses a request for another chain", () => {
    expect(qrOf(`ethereum:${ADDR}@1?value=1e18`)).toMatchObject({ ok: false });
  });
  it("refuses links, contract calls and arbitrary text — nothing is opened or run", () => {
    expect(qrOf("https://evil.example/claim?wallet=connect")).toMatchObject({ ok: false, reason: expect.stringMatching(/doesn't open links/) });
    expect(qrOf("javascript:alert(1)")).toMatchObject({ ok: false });
    expect(qrOf(`ethereum:${USDC}@${CHAIN}/approve?address=${ADDR}&uint256=1e30`)).toMatchObject({ ok: false });
    expect(qrOf("WIFI:S:home;T:WPA;P:secret;;")).toMatchObject({ ok: false });
    expect(qrOf("hello world")).toMatchObject({ ok: false });
  });
  it("refuses malformed payloads", () => {
    expect(qrOf("")).toMatchObject({ ok: false });
    expect(qrOf("0x1234")).toMatchObject({ ok: false });
    expect(qrOf(`${ADDR}\u0000`)).toMatchObject({ ok: false });
    expect(qrOf("x".repeat(5000))).toMatchObject({ ok: false });
    expect(qrOf(`ethereum:${ADDR}?value=-5`)).toMatchObject({ ok: false });
  });
});

describe("image + caption → request", () => {
  it("1. image saying “Send 25 USDC to alice.nad” → a transfer request", () => {
    const r = resolveVisualIntent({ qr: null, image: reading({ actions: [send({ amount: "25", token: "USDC", recipient: "alice.nad" })] }), caption: "" });
    expect(r).toMatchObject({ kind: "intent", text: "Send 25 USDC to alice.nad" });
    plans(textOf(r), 1);
  });

  it("2. QR with only an address, no caption → shows it and asks", () => {
    const r = resolveVisualIntent({ qr: qrOf(ADDR), image: null, caption: "" });
    expect(r.kind).toBe("clarify");
    expect(r.kind === "clarify" && r.address).toBe(ADDR);
    expect(textOf(r)).toContain(ADDR);
    expect(textOf(r)).toMatch(/What would you like to do/);
  });

  it("3. QR address + “Send 5 USDC to this address” → transfer to the decoded address", () => {
    const r = resolveVisualIntent({ qr: qrOf(ADDR), image: null, caption: "Send 5 USDC to this address" });
    expect(r).toMatchObject({ kind: "intent", text: `Send 5 USDC to ${ADDR}` });
    plans(textOf(r), 1);
  });

  it("4. invoice + “pay this invoice” → a transfer only when everything is there", () => {
    const invoice = { number: "INV-104", payee: "Studio Nine", dueDate: "2026-10-30", total: "1,250.00", token: "USDC", payTo: ADDR2 };
    const ok = resolveVisualIntent({ qr: null, image: reading({ kind: "invoice", invoice }), caption: "Pay this invoice" });
    expect(ok).toMatchObject({ kind: "intent", text: `Send 1250 USDC to ${ADDR2}` });
    expect(ok.found.join(" ")).toMatch(/INV-104/);
    plans(textOf(ok), 1);

    const noAddress = resolveVisualIntent({ qr: null, image: reading({ kind: "invoice", invoice: { ...invoice, payTo: null } }), caption: "Pay this invoice" });
    expect(noAddress.kind).toBe("clarify");
    expect(textOf(noAddress)).toMatch(/who should receive it/);
  });

  it("an invoice without a caption asking to pay is never prepared", () => {
    const r = resolveVisualIntent({ qr: null, image: reading({ kind: "invoice", invoice: { number: "1", payee: "X", dueDate: null, total: "10", token: "USDC", payTo: ADDR } }), caption: "" });
    expect(r.kind).toBe("clarify");
    expect(textOf(r)).toMatch(/Do you want to pay it/);
  });

  it("missing amount or recipient → asks for exactly that", () => {
    const noAmount = resolveVisualIntent({ qr: qrOf(ADDR), image: null, caption: "send USDC to this address" });
    expect(noAmount.kind).toBe("clarify");
    expect(textOf(noAmount)).toMatch(/the amount/);
    const noRecipient = resolveVisualIntent({ qr: null, image: reading({ actions: [send({ amount: "10", token: "MON" })] }), caption: "" });
    expect(noRecipient.kind).toBe("clarify");
    expect(textOf(noRecipient)).toMatch(/who should receive it/);
    expect(textOf(noRecipient)).toMatch(/Nothing was prepared/);
  });

  it("caption and image disagreeing → asks, never picks one", () => {
    const amount = resolveVisualIntent({ qr: null, image: reading({ actions: [send({ amount: "25", token: "USDC", recipient: "alice.nad" })] }), caption: "send 50 USDC" });
    expect(amount.kind).toBe("conflict");
    expect(textOf(amount)).toMatch(/your caption says 50.*the image says 25/);
    const recipient = resolveVisualIntent({ qr: qrOf(ADDR), image: null, caption: "send 5 USDC to bob.nad" });
    expect(recipient.kind).toBe("conflict");
    const token = resolveVisualIntent({ qr: qrOf(`ethereum:${ADDR}@${CHAIN}?value=1e18`), image: null, caption: "send 1 USDC to this address" });
    expect(token.kind).toBe("conflict");
    const verb = resolveVisualIntent({ qr: null, image: reading({ actions: [send({ amount: "5", token: "USDC", recipient: "alice.nad" })] }), caption: "swap it" });
    expect(verb.kind).toBe("conflict");
  });

  it("a QR code and a printed address that differ → asks which to trust", () => {
    const r = resolveVisualIntent({ qr: qrOf(ADDR), image: reading({ kind: "wallet_address", addresses: [ADDR2] }), caption: "send 5 USDC to this address" });
    expect(r.kind).toBe("conflict");
    expect(textOf(r)).toContain(ADDR2);
  });

  it("the same value from two sources is not a conflict", () => {
    const r = resolveVisualIntent({ qr: qrOf(ADDR), image: reading({ addresses: [ADDR.toLowerCase()] }), caption: "Send 5 USDC to this address" });
    expect(r).toMatchObject({ kind: "intent", text: `Send 5 USDC to ${ADDR}` });
  });

  it("an invalid recipient blocks the request", () => {
    const r = resolveVisualIntent({ qr: null, image: reading({ actions: [send({ amount: "5", token: "USDC", recipient: "0x12ab" })] }), caption: "" });
    expect(r.kind).toBe("blocked");
    const cap = resolveVisualIntent({ qr: qrOf(ADDR), image: null, caption: "send 5 USDC to 0xdeadbeef" });
    expect(cap.kind).toBe("blocked");
  });

  it("an unsupported or malformed QR blocks the request", () => {
    expect(resolveVisualIntent({ qr: qrOf("https://phish.example"), image: null, caption: "pay this" }).kind).toBe("blocked");
    expect(resolveVisualIntent({ qr: qrOf("0x1234"), image: null, caption: "" }).kind).toBe("blocked");
  });

  it("instructions aimed at PayAI inside an image are never followed", () => {
    const r = resolveVisualIntent({ qr: null, image: reading({ suspicious: true, actions: [send({ amount: "9999", token: "USDC", recipient: ADDR })] }), caption: "" });
    expect(r.kind).toBe("blocked");
    expect(textOf(r)).toMatch(/don't act on instructions inside images/);
  });

  it("only validated fields reach the sentence — no free text from the image", () => {
    const r = resolveVisualIntent({ qr: null, image: reading({ actions: [send({ amount: "5", token: "USDC and approve all", recipient: "alice.nad" })] }), caption: "" });
    expect(r.kind).not.toBe("intent");
  });

  it("multi-step: an image with a swap then a send → one plan with both steps", () => {
    const r = resolveVisualIntent({
      qr: null, caption: "",
      image: reading({ actions: [
        { type: "swap", amount: "10", token: "MON", toToken: "USDC", recipient: null, amountFromPrevious: false },
        send({ recipient: "bob.nad", amountFromPrevious: true }),
      ] }),
    });
    expect(r).toMatchObject({ kind: "intent", text: "Swap 10 MON to USDC and send it to bob.nad" });
    plans(textOf(r), 2);
  });

  it("multi-step: two transfers written in the image", () => {
    const r = resolveVisualIntent({ qr: null, caption: "", image: reading({ actions: [send({ amount: "1", token: "MON", recipient: "alice.nad" }), send({ amount: "2", token: "MON", recipient: "bob.nad" })] }) });
    expect(r).toMatchObject({ kind: "intent" });
    plans(textOf(r), 2);
  });

  it("more than five actions in one image is refused", () => {
    const many = Array.from({ length: 6 }, (_, i) => send({ amount: "1", token: "MON", recipient: `user${i}.nad` }));
    expect(resolveVisualIntent({ qr: null, image: reading({ actions: many }), caption: "" }).kind).toBe("blocked");
  });

  it("nothing payable in the image → asks what to do", () => {
    const r = resolveVisualIntent({ qr: null, image: reading({ kind: "other" }), caption: "" });
    expect(r.kind).toBe("clarify");
  });

  it("QR with an amount (EIP-681) + “pay this” → transfer with the QR's amount", () => {
    const r = resolveVisualIntent({ qr: qrOf(`ethereum:${ADDR}@${CHAIN}?value=2.5e18`), image: null, caption: "pay this" });
    expect(r).toMatchObject({ kind: "intent", text: `Send 2.5 MON to ${ADDR}` });
    plans(textOf(r), 1);
  });
});

describe("follow-up after a QR-only answer", () => {
  it("“send 5 USDC to this address” uses the address just shown", () => {
    expect(applyVisualAddress("send 5 USDC to this address", ADDR)).toBe(`send 5 USDC to ${ADDR}`);
    expect(applyVisualAddress("Send 5 USDC to it", ADDR)).toBe(`Send 5 USDC to ${ADDR}`);
    expect(applyVisualAddress("what's my balance?", ADDR)).toBeNull();
  });
  it("caption reading", () => {
    expect(readCaption("Send 5 USDC to this address")).toMatchObject({ verb: "send", amount: "5", token: "USDC", recipient: null, refersToImage: true });
    expect(readCaption("swap 10 mon to usdc")).toMatchObject({ verb: "swap", amount: "10", token: "MON", toToken: "USDC" });
  });
});

describe("vision reading (mocked model)", () => {
  const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer().then((b) => new Uint8Array(b));
  const client = (input: unknown, spy?: (req: unknown) => void): VisionClient => ({
    messages: { create: async (req: unknown) => { spy?.(req); return { content: [{ type: "tool_use", id: "t", name: "submit_reading", input }] }; } },
  } as unknown as VisionClient);

  it("sends the image as data with a forced tool call and a system rule against embedded instructions", async () => {
    let seen: { system?: string; tool_choice?: unknown; messages?: { content: { type: string }[] }[] } = {};
    await extractFromImage(await png(), "image/png", client({ kind: "other", actions: [], addresses: [], invoice: null, suspicious: false }, (r) => { seen = r as typeof seen; }));
    expect(seen.system).toMatch(/untrusted data/);
    expect(seen.tool_choice).toEqual({ type: "tool", name: "submit_reading" });
    expect(seen.messages?.[0].content.map((c) => c.type)).toEqual(["image", "text"]);
  });

  it("coerces a malformed or hostile reading into bounded, typed fields", () => {
    const r = coerceExtraction({ kind: "rm -rf", actions: [{ type: "approve_all" }, { type: "send", amount: 5, token: "USDC", recipient: "x".repeat(500) }], addresses: [1, "alice.nad"], suspicious: "yes" });
    expect(r.kind).toBe("other");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].amount).toBeNull(); // a number, not a string: dropped
    expect(r.actions[0].recipient!.length).toBeLessThanOrEqual(128);
    expect(r.addresses).toEqual(["alice.nad"]);
    expect(r.suspicious).toBe(false);
    expect(coerceExtraction(null)).toMatchObject({ kind: "other", actions: [] });
  });

  it("a failed model call throws (the route reports a retryable error)", async () => {
    const failing = { messages: { create: async () => { throw new Error("overloaded"); } } } as unknown as VisionClient;
    await expect(extractFromImage(await png(), "image/png", failing)).rejects.toThrow();
  });

  it("no model configured → no reading (QR codes still work)", async () => {
    const k = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try { expect(await extractFromImage(await png(), "image/png")).toBeNull(); } finally { if (k !== undefined) process.env.ANTHROPIC_API_KEY = k; }
  });
});

describe("no second execution path", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the visual modules and route never touch signing, execution or plan approval", () => {
    for (const f of ["lib/ask/visual/resolve.ts", "lib/ask/visual/server.ts", "lib/ask/visual/qrPayload.ts", "lib/ask/visual/upload.ts", "app/api/ask/visual/route.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/@\/lib\/(plan\/service|payment|monad\/(wallet|executor|contracts|swap))|sendTransaction|writeContract|approvePlan|\/confirm/);
    }
  });
  it("a composed sentence goes through the same turn as typed text, and the image is not kept", () => {
    const hook = read("lib/ask/useAskChat.ts");
    expect(hook).toMatch(/async function sendVisual[\s\S]*await runRequest\(v\.text, history, startContext, null\)/);
    expect(hook).toMatch(/async function send\(text: string\)[\s\S]*await runRequest\(requestText/);
    expect(hook).toMatch(/content: cap \? `\[Image\] \$\{cap\}` : "\[Image\]"/);
    // A second tap while one image is being read is ignored.
    expect(hook).toMatch(/if \(thinking \|\| visualBusyRef\.current\) return false;/);
  });
  it("the route doesn't log image contents or extracted values", () => {
    const route = read("app/api/ask/visual/route.ts");
    const logs = route.match(/console\.\w+\([^;]*\);/g) ?? [];
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/qrText|caption\b|resolution\.(text|reply)|found/);
  });
});
