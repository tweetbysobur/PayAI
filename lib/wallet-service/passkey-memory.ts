/**
 * Where this browser remembers which PayAI passkey it last used.
 *
 * localStorage does not cross from usepayai.xyz to app.usepayai.xyz, which
 * made the app host look like a brand-new device and mint a second passkey.
 * The credential id is a public WebAuthn identifier (it cannot sign), so it
 * is also stored in a cookie scoped to `.usepayai.xyz`.
 *
 * The cookie is a hint, not a key. Sign-in still asks the authenticator for
 * every PayAI passkey on the domain, so a hint that points at the wrong
 * (newer, empty) passkey cannot hide the original one.
 */
import { cookieDomain, hostnameOf } from "@/lib/hosts";

export const PASSKEY_STORAGE_KEY = "payai_mera_credential";
export const PASSKEY_ADDRESS_KEY = "payai_mera_address";
export const PASSKEY_COOKIE = "payai_pk";

const MAX_AGE_SECONDS = 60 * 60 * 24 * 400;
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export interface PasskeyMemory {
  credentialId: string;
  transports?: string[];
  address?: string;
}

export function parsePasskeyMemory(raw: string | null | undefined): PasskeyMemory | null {
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith("{") ? raw : decodeB64Url(raw.trim());
    const value = JSON.parse(json) as Partial<PasskeyMemory>;
    if (typeof value.credentialId !== "string" || !ID_RE.test(value.credentialId)) return null;
    const transports = Array.isArray(value.transports)
      ? value.transports.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length < 32).slice(0, 8)
      : undefined;
    const address = typeof value.address === "string" && ADDR_RE.test(value.address) ? value.address : undefined;
    return {
      credentialId: value.credentialId,
      ...(transports && transports.length > 0 ? { transports } : {}),
      ...(address ? { address } : {}),
    };
  } catch {
    return null;
  }
}

export function encodePasskeyCookie(mem: PasskeyMemory): string {
  const bytes = new TextEncoder().encode(JSON.stringify(mem));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeB64Url(value: string): string {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Last occurrence wins, matching how browsers surface duplicate cookie names. */
export function readCookieValue(header: string, name: string): string | null {
  let found: string | null = null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const raw = trimmed.slice(eq + 1);
    try {
      found = decodeURIComponent(raw);
    } catch {
      found = raw;
    }
  }
  return found;
}

export function passkeyCookieAttributes(hostname: string, secure: boolean): string {
  const domain = cookieDomain(hostname);
  const bits = ["Path=/", `Max-Age=${MAX_AGE_SECONDS}`, "SameSite=Lax"];
  if (domain) bits.push(`Domain=${domain}`);
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function loadPasskeyMemory(): PasskeyMemory | null {
  if (typeof window === "undefined") return null;
  let local: PasskeyMemory | null = null;
  try {
    local = parsePasskeyMemory(localStorage.getItem(PASSKEY_STORAGE_KEY));
    if (local && !local.address) {
      const address = localStorage.getItem(PASSKEY_ADDRESS_KEY);
      if (address && ADDR_RE.test(address)) local = { ...local, address };
    }
  } catch {
    local = null;
  }
  if (local) return local;
  const fromCookie = parsePasskeyMemory(readCookieValue(document.cookie, PASSKEY_COOKIE));
  if (!fromCookie) return null;
  try {
    localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify({
      credentialId: fromCookie.credentialId,
      ...(fromCookie.transports ? { transports: fromCookie.transports } : {}),
    }));
    if (fromCookie.address) localStorage.setItem(PASSKEY_ADDRESS_KEY, fromCookie.address);
  } catch {
    /* private mode — the cookie hint is still enough for this page */
  }
  return fromCookie;
}

export function savePasskeyMemory(mem: PasskeyMemory): void {
  if (typeof window === "undefined") return;
  const clean = parsePasskeyMemory(JSON.stringify(mem));
  if (!clean) return;
  try {
    localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify({
      credentialId: clean.credentialId,
      ...(clean.transports ? { transports: clean.transports } : {}),
    }));
  } catch {
    /* private mode */
  }
  if (clean.address) {
    try { localStorage.setItem(PASSKEY_ADDRESS_KEY, clean.address); } catch { /* private mode */ }
  }
  try {
    const secure = window.location.protocol === "https:";
    const attrs = passkeyCookieAttributes(hostnameOf(window.location.host), secure);
    document.cookie = `${PASSKEY_COOKIE}=${encodeURIComponent(encodePasskeyCookie(clean))}; ${attrs}`;
  } catch {
    /* cookies blocked — localStorage still holds the hint on this origin */
  }
}

export function clearPasskeyMemory(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PASSKEY_STORAGE_KEY);
    localStorage.removeItem(PASSKEY_ADDRESS_KEY);
  } catch {
    /* nothing stored */
  }
  try {
    const host = hostnameOf(window.location.host);
    const domain = cookieDomain(host);
    const expired = `${PASSKEY_COOKIE}=; Path=/; Max-Age=0`;
    document.cookie = domain ? `${expired}; Domain=${domain}` : expired;
  } catch {
    /* nothing stored */
  }
}
