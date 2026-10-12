import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/ask/visual — Ask PayAI's visual intent input.
 *
 * multipart/form-data: `image` (PNG, JPEG or WebP, ≤ 4 MB) and an optional
 * `caption`. Returns a VisualResolution (lib/ask/visual/resolve.ts): either a
 * plain request sentence the client runs through the NORMAL Ask turn — plan
 * grammar, validation, review card, wallet approval — or a question.
 *
 * This route reads; it never prepares, approves or executes a transaction,
 * and an image is never treated as approval. The image is held in memory for
 * this request only: not stored, not logged, never given a URL.
 *
 * Requires the wallet grant (it spends a model call per request) and is rate
 * limited per wallet and per IP.
 */
export const maxDuration = 30;
export const runtime = "nodejs";

const noStore = (res: NextResponse) => { res.headers.set("Cache-Control", "no-store"); return res; };
const fail = (status: number, code: string, message: string, retryable = false) =>
  noStore(NextResponse.json({ ok: false, code, message, retryable }, { status }));

export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const ipLimited = await rateLimited(req, "ask-visual-ip", { max: 30, windowSec: 300 });
  if (ipLimited) return noStore(ipLimited);

  const { planAuthFrom } = await import("@/lib/plan/http");
  const auth = planAuthFrom(req);
  if (!auth) return fail(401, "wallet_grant_required", "Unlock your wallet to read images in Ask PayAI.");
  const limited = await rateLimited(req, "ask-visual", { max: 10, windowSec: 300, subject: auth.wallet });
  if (limited) return noStore(limited);

  const { MAX_IMAGE_BYTES, checkUpload } = await import("@/lib/ask/visual/upload");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES + 64 * 1024) return fail(413, "too_large", "That image is larger than 4 MB. Try a screenshot or a smaller photo.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "bad_request", "Send the image as a file upload.");
  }
  const file = form.get("image");
  if (!(file instanceof Blob)) return fail(400, "bad_request", "Attach an image.");
  if (file.size > MAX_IMAGE_BYTES) return fail(413, "too_large", "That image is larger than 4 MB. Try a screenshot or a smaller photo.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkUpload(bytes);
  if (!check.ok) return fail(check.code === "too_large" ? 413 : 415, check.code, check.message);

  const { MAX_INPUT_LENGTH, sanitizeInput } = await import("@/lib/agent/brain");
  const rawCaption = typeof form.get("caption") === "string" ? (form.get("caption") as string).trim() : "";
  if (rawCaption.length > MAX_INPUT_LENGTH) return fail(400, "caption_too_long", `Keep the caption to ${MAX_INPUT_LENGTH} characters.`);
  const caption = rawCaption ? sanitizeInput(rawCaption) : "";

  const { checkDecodable, decodeQr, extractFromImage } = await import("@/lib/ask/visual/server");
  try {
    const reason = await checkDecodable(bytes);
    if (reason) return fail(422, "bad_dimensions", reason);
  } catch {
    return fail(415, "undecodable", "That file couldn't be read as an image.");
  }

  const { parseQrPayload } = await import("@/lib/ask/visual/qrPayload");
  const { getChain } = await import("@/lib/monad/config");
  let qrText: string | null = null;
  try { qrText = await decodeQr(bytes); } catch { qrText = null; }
  const qr = qrText != null ? parseQrPayload(qrText, getChain().id) : null;

  let image = null;
  let visionFailed = false;
  try {
    image = await extractFromImage(bytes, check.type);
  } catch {
    visionFailed = true;
  }
  if (!qr && !image) {
    return visionFailed
      ? fail(502, "processing_failed", "PayAI couldn't read that image just now. Try again in a moment.", true)
      : fail(422, "nothing_read", "No QR code was found, and reading text from images isn't available right now. Type the request instead.");
  }

  const { resolveVisualIntent } = await import("@/lib/ask/visual/resolve");
  const resolution = resolveVisualIntent({ qr, image, caption });
  // Outcome only — never the image, the QR payload or the extracted values.
  console.log(`[AskVisual] bytes=${bytes.length} type=${check.type} qr=${qr ? (qr.ok ? "ok" : "refused") : "none"} vision=${image ? image.kind : visionFailed ? "failed" : "off"} result=${resolution.kind}`);
  return noStore(NextResponse.json({ ok: true, resolution, ...(visionFailed ? { partial: true } : {}) }));
}
