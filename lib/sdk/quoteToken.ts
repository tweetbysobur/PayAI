/**
 * The SDK preview → build security boundary.
 *
 * The preview route (/api/ask/action) issues a quote token after it has
 * validated and quoted an action. The build route (/api/ask/action/build)
 * REQUIRES that token and verifies it before it will construct anything a
 * wallet could sign. The token is an HMAC over:
 *
 *   protocolId, actionId, version, chainId — the exact action quoted
 *   inputsHash  — sha256 of the exact validated inputs the user previewed
 *   quotedAt    — when the server produced the quote
 *   quoteId     — a random id for this quote (the idempotency key at build)
 *
 * So the client can't (a) build different inputs from the ones it previewed,
 * (b) refresh or invent a quote timestamp — build takes quotedAt ONLY from the
 * verified token, never from the request body, and a missing token fails
 * closed — or (c) reuse a quote across actions, versions or chains.
 *
 * Signed with AUTH_SESSION_SECRET under its own domain prefix, the same
 * secret and pattern lib/auth/walletGrant.ts uses; required in production.
 *
 * Server-only.
 */
import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ActionInputs } from "./types";

const DOMAIN = "sdk-quote.v1.";

function secret(): string {
  const s = process.env.AUTH_SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET must be set in production to sign SDK quotes.");
  }
  return "dev-only-insecure-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`${DOMAIN}${payload}`).digest("base64url");
}

/**
 * Canonical serialization of validated inputs: top-level keys sorted, each
 * list item's keys sorted, list ORDER preserved (order is meaningful — it is
 * which recipient gets which amount). Two semantically identical input maps
 * always hash the same; any change to any value, key, or order does not.
 */
export function canonicalInputs(inputs: ActionInputs): string {
  const sortObj = (o: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const top = Object.keys(inputs).sort().map((k) => {
    const v = inputs[k];
    return [k, typeof v === "string" ? v : v.map(sortObj)];
  });
  return JSON.stringify(top);
}

export function inputsHash(inputs: ActionInputs): string {
  return createHash("sha256").update(canonicalInputs(inputs)).digest("hex");
}

export interface QuoteIdentity {
  protocolId: string;
  actionId: string;
  version: string;
  chainId: number;
}

interface QuotePayload {
  p: string; a: string; v: string; c: number;
  h: string; t: number; q: string;
}

export function issueQuoteToken(id: QuoteIdentity, inputs: ActionInputs, quotedAt: number): { quoteToken: string; quoteId: string } {
  const quoteId = randomBytes(16).toString("hex");
  const payload: QuotePayload = {
    p: id.protocolId, a: id.actionId, v: id.version, c: id.chainId,
    h: inputsHash(inputs), t: quotedAt, q: quoteId,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { quoteToken: `${encoded}.${sign(encoded)}`, quoteId };
}

export type QuoteVerifyResult =
  | { ok: true; quotedAt: number; quoteId: string }
  | { ok: false; message: string };

const QUOTE_ID_RE = /^[0-9a-f]{32}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Verify a quote token against the action being built and the exact
 * validated inputs being built. Any mismatch, malformation, or bad signature
 * fails closed with one generic reason (the user simply re-quotes).
 */
export function verifyQuoteToken(token: unknown, id: QuoteIdentity, inputs: ActionInputs): QuoteVerifyResult {
  const refuse = (message = "This preview can't be used to build the action — please request a fresh preview."): QuoteVerifyResult => ({ ok: false, message });
  if (typeof token !== "string" || token.length > 2048) return refuse("A fresh preview is required before this action can be built.");
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return refuse();
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = Buffer.from(sign(encoded));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return refuse();

  let payload: QuotePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as QuotePayload;
  } catch {
    return refuse();
  }
  if (
    !payload || typeof payload !== "object" ||
    typeof payload.t !== "number" || !Number.isSafeInteger(payload.t) ||
    typeof payload.q !== "string" || !QUOTE_ID_RE.test(payload.q) ||
    typeof payload.h !== "string" || !HASH_RE.test(payload.h)
  ) return refuse();

  if (payload.p !== id.protocolId || payload.a !== id.actionId || payload.v !== id.version || payload.c !== id.chainId) {
    return refuse();
  }
  if (payload.h !== inputsHash(inputs)) {
    return refuse("These details differ from the preview you saw — please request a fresh preview.");
  }
  return { ok: true, quotedAt: payload.t, quoteId: payload.q };
}
