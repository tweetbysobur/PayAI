/**
 * Visual intent input — upload rules, shared by the Ask composer (client)
 * and POST /api/ask/visual (server, which re-checks everything).
 *
 * The type is decided from the file's own first bytes, never from its name
 * or the browser's declared MIME type. Pure; no I/O.
 */

/** Under Vercel's 4.5 MB request-body ceiling, with room for the caption. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Decoded-size ceiling (a tiny file can still decode to a huge bitmap). */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Longest side, and shortest side below which nothing is legible. */
export const MAX_IMAGE_SIDE = 8000;
export const MIN_IMAGE_SIDE = 32;

/** Null when the dimensions are acceptable, else the reason. */
export function checkDimensions(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return "That file couldn't be read as an image.";
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) return `That image is too large (max ${MAX_IMAGE_SIDE} px on a side).`;
  if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) return "That image is too small to read.";
  return null;
}
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

export type UploadCheck =
  | { ok: true; type: AcceptedImageType }
  | { ok: false; code: "empty" | "too_large" | "unsupported_type"; message: string };

/** The real image type from its magic bytes, or null. */
export function sniffImageType(bytes: Uint8Array): AcceptedImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return null;
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}

export function checkUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.length === 0) return { ok: false, code: "empty", message: "That file is empty." };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, code: "too_large", message: "That image is larger than 4 MB. Try a screenshot or a smaller photo." };
  }
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, code: "unsupported_type", message: "Use a PNG, JPEG or WebP image." };
  return { ok: true, type };
}
