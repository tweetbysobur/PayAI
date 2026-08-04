/**
 * "Continue with Email" — a one-time code sent to the user's inbox.
 *
 * Security posture (this is an auth path — it gates wallet access):
 *   - The code is NEVER stored in plaintext. Only a salted SHA-256 hash is
 *     persisted, so a KV dump can't be replayed into someone's wallet.
 *   - Single-use: a successful verification immediately invalidates the
 *     record, so a code observed in transit can't be reused.
 *   - Attempt-capped: MAX_ATTEMPTS guesses per issued code, then it's burned.
 *     A 6-digit code is only ~20 bits, so an uncapped verify endpoint is
 *     brute-forceable; this is what makes the short code safe.
 *   - Constant-time comparison, so the hash can't be recovered by timing.
 *   - TTL on the stored record (KV `expire`, and an explicit expiresAt check
 *     for the in-memory dev path, which has no expiry of its own).
 *
 * Delivery is Resend's REST API over plain `fetch` — no SDK dependency. It's
 * the single seam to swap for SES/Postmark: replace sendEmail() below and
 * nothing else changes. Gated on AUTH_EMAIL_API_KEY + AUTH_EMAIL_FROM: with
 * either unset this refuses cleanly rather than claiming to have sent mail
 * nothing will deliver.
 *
 * Server-only.
 */
import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { getRedis } from "@/lib/platform/kv";

const CODE_TTL_SECONDS = 10 * 60;
/** Guesses allowed per issued code before it's burned. A 6-digit code has
 *  900k possibilities; 5 tries makes online brute force hopeless while
 *  leaving room for honest typos. */
const MAX_ATTEMPTS = 5;

const key = (email: string) => `payai:auth:email-code:${normalize(email)}`;

interface CodeRecord {
  /** Salted SHA-256 of the code — never the code itself. */
  hash: string;
  expiresAt: number;
  attempts: number;
}

const g = globalThis as unknown as { __payaiEmailCodes?: Map<string, CodeRecord> };
const mem = (g.__payaiEmailCodes ??= new Map());

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** Salted with the normalized email so the same code for two addresses
 *  hashes differently — a precomputed table over 900k codes is useless. */
function hashCode(email: string, code: string): string {
  return createHash("sha256").update(`${normalize(email)}:${code}`).digest("hex");
}

export function isEmailAuthConfigured(): boolean {
  return !!process.env.AUTH_EMAIL_API_KEY?.trim() && !!process.env.AUTH_EMAIL_FROM?.trim();
}

async function readRecord(email: string): Promise<CodeRecord | null> {
  const r = await getRedis();
  const raw = r ? await r.get(key(email)) : mem.get(key(email));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as CodeRecord) : (raw as CodeRecord);
  } catch {
    return null;
  }
}

async function writeRecord(email: string, record: CodeRecord): Promise<void> {
  const r = await getRedis();
  if (r) {
    await r.set(key(email), JSON.stringify(record));
    await r.expire(key(email), CODE_TTL_SECONDS);
  } else {
    mem.set(key(email), record);
  }
}

/** Burn a code so it can't be reused or further guessed. There's no `del` on
 *  the shared RedisLike surface, so this overwrites with an already-expired
 *  record — readRecord/verify both treat that as "no valid code". */
async function invalidate(email: string): Promise<void> {
  await writeRecord(email, { hash: "", expiresAt: 0, attempts: MAX_ATTEMPTS });
}

/**
 * The one delivery seam. Swapping providers means rewriting this function
 * and nothing else — callers only ever see "sent" or a thrown error.
 */
async function sendEmail(to: string, code: string): Promise<void> {
  const apiKey = process.env.AUTH_EMAIL_API_KEY!.trim();
  const from = process.env.AUTH_EMAIL_FROM!.trim();

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `${code} is your PayAI sign-in code`,
      text: `Your PayAI sign-in code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, you can safely ignore this email — nobody can access your wallet without this code.`,
      html:
        `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:420px;margin:0 auto;padding:32px 24px">` +
        `<h1 style="font-size:18px;font-weight:600;color:#111;margin:0 0 8px">Your PayAI sign-in code</h1>` +
        `<p style="font-size:14px;color:#555;margin:0 0 24px">Enter this code to finish signing in. It expires in 10 minutes.</p>` +
        `<p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#7C3AED;margin:0 0 24px">${code}</p>` +
        `<p style="font-size:12px;color:#888;margin:0">If you didn't request this, you can safely ignore this email — nobody can access your wallet without this code.</p>` +
        `</div>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    // Surface the provider's status but never its response body — it can
    // echo the recipient address and internal ids into our logs.
    throw new Error(`Could not send the sign-in code (mail provider returned ${res.status}).`);
  }
}

/** Issues a fresh 6-digit code and emails it. Any previously issued code for
 *  this address is replaced, so requesting a new one invalidates the old. */
export async function sendEmailCode(email: string): Promise<void> {
  if (!isEmailAuthConfigured()) {
    throw new Error("Email sign-in is not configured yet (set AUTH_EMAIL_API_KEY and AUTH_EMAIL_FROM).");
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

  // Persist before sending so there's no window where a delivered code isn't
  // yet verifiable; if delivery fails, burn it rather than leaving a live
  // code nobody received.
  await writeRecord(email, {
    hash: hashCode(email, code),
    expiresAt: Date.now() + CODE_TTL_SECONDS * 1000,
    attempts: 0,
  });
  try {
    await sendEmail(normalize(email), code);
  } catch (e) {
    await invalidate(email).catch(() => {});
    throw e;
  }
}

/** True only for a live, unexpired, unburned code — and consumes it on
 *  success so it can never be replayed. */
export async function verifyEmailCode(email: string, code: string): Promise<boolean> {
  const record = await readRecord(email);
  if (!record || !record.hash || Date.now() > record.expiresAt) return false;

  if (record.attempts >= MAX_ATTEMPTS) {
    await invalidate(email);
    return false;
  }
  // Count the attempt BEFORE comparing, so a caller that aborts mid-request
  // still pays for the guess.
  await writeRecord(email, { ...record, attempts: record.attempts + 1 });

  const expected = Buffer.from(record.hash, "hex");
  const actual = Buffer.from(hashCode(email, code), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  await invalidate(email); // single use
  return true;
}
