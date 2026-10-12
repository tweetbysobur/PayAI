"use client";

/**
 * Gets a picked image ready to upload, in the browser: PNG/JPEG/WebP under
 * the limit go as they are; anything else the browser can decode (a large
 * phone photo, HEIC on iOS) is redrawn on a canvas — at most 2000 px on its
 * long side — and re-encoded as JPEG. The result is re-checked with the same
 * rules the server applies (lib/ask/visual/upload.ts).
 */
import { checkDimensions, checkUpload, MAX_IMAGE_BYTES, MIN_IMAGE_SIDE } from "./upload";

const MAX_SIDE = 2000;

export type PreparedImage = { ok: true; blob: Blob } | { ok: false; message: string };

async function bytesOf(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

async function reencode(file: Blob): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    if (img.naturalWidth < MIN_IMAGE_SIDE || img.naturalHeight < MIN_IMAGE_SIDE) return null;
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function dimensionsOf(file: Blob): Promise<{ w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const d = { w: bmp.width, h: bmp.height };
    bmp.close();
    return d;
  } catch {
    return null;
  }
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) return { ok: false, message: "Choose an image file (PNG, JPEG or WebP)." };
  if (file.size > 25 * 1024 * 1024) return { ok: false, message: "That image is too large. Try a screenshot instead." };
  const first = checkUpload(await bytesOf(file));
  const dims = await dimensionsOf(file);
  if (dims && (dims.w < MIN_IMAGE_SIDE || dims.h < MIN_IMAGE_SIDE)) return { ok: false, message: "That image is too small to read." };
  // Within every limit as it is: upload unchanged. Otherwise (too big, too
  // many pixels, or a format the server doesn't take) redraw it smaller.
  if (first.ok && dims && checkDimensions(dims.w, dims.h) === null) return { ok: true, blob: file };
  const redrawn = await reencode(file);
  if (!redrawn) return { ok: false, message: "That image couldn't be opened. Use a PNG, JPEG or WebP image." };
  const second = checkUpload(await bytesOf(redrawn));
  if (!second.ok) return { ok: false, message: redrawn.size > MAX_IMAGE_BYTES ? "That image is larger than 4 MB even after resizing. Try a screenshot." : second.message };
  return { ok: true, blob: redrawn };
}
