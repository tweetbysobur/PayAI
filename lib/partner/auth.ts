/**
 * Partner apps — other products that use PayAI's swap engine from their own
 * backend (Dubu is the first). Server-to-server only, never from a browser.
 *
 * Each partner is configured in PAYAI_PARTNERS as JSON:
 *
 *   [{ "id": "dubu",
 *      "keySha256": "<sha256 hex of the partner's API key>",
 *      "tokens": ["0x350035555E10d9AfAF1566AaebfCeD5BA6C27777"],
 *      "maxMon": 100 }]
 *
 * Only the key's hash is stored here; the key itself lives only in the
 * partner's own server env. A partner can only buy the tokens on its list,
 * with native MON, up to maxMon per swap. Swaps are always built with the
 * partner's user as the only recipient, and the user signs them in the
 * partner's app — PayAI never holds funds or keys for a partner.
 *
 * Server-only.
 */
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

export interface Partner {
  id: string;
  /** Lowercased token addresses this partner may buy. */
  tokens: string[];
  maxMon: number;
}

interface PartnerConfig extends Partner {
  keyHash: Buffer;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z0-9-]{2,32}$/;

/** Parses PAYAI_PARTNERS. A malformed entry is dropped, never half-trusted. */
export function loadPartners(raw = process.env.PAYAI_PARTNERS): PartnerConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[partner] PAYAI_PARTNERS is not valid JSON; no partners loaded");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PartnerConfig[] = [];
  for (const p of parsed) {
    if (!p || typeof p !== "object") continue;
    const { id, keySha256, tokens, maxMon } = p as Record<string, unknown>;
    const hash = typeof keySha256 === "string" ? keySha256.trim().toLowerCase() : "";
    const list = Array.isArray(tokens) ? tokens.filter((t): t is string => typeof t === "string" && ADDR_RE.test(t)) : [];
    const max = typeof maxMon === "number" && Number.isFinite(maxMon) && maxMon > 0 ? maxMon : 0;
    if (typeof id !== "string" || !ID_RE.test(id) || !HASH_RE.test(hash) || list.length === 0 || max === 0) {
      console.error(`[partner] skipping malformed partner entry ${typeof id === "string" ? id : "?"}`);
      continue;
    }
    out.push({ id, keyHash: Buffer.from(hash, "hex"), tokens: list.map((t) => t.toLowerCase()), maxMon: max });
  }
  return out;
}

/** The partner whose API key is in `Authorization: Bearer <key>`, or null. */
export function partnerForKey(authorization: string | null, partners = loadPartners()): Partner | null {
  const m = authorization?.match(/^Bearer\s+(\S{32,256})$/);
  if (!m) return null;
  const hash = createHash("sha256").update(m[1]).digest();
  let found: Partner | null = null;
  // Compare against every partner (no early exit), each in constant time.
  for (const p of partners) {
    if (timingSafeEqual(hash, p.keyHash) && !found) found = { id: p.id, tokens: p.tokens, maxMon: p.maxMon };
  }
  return found;
}
