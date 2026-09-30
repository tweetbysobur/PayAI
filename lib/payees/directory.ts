/**
 * Payee directory — resolves a configured name ("treasury") to a wallet address.
 *
 * The agent parses a recipient that may be a name or a 0x address. On-chain
 * settlement needs an address, so named payees are resolved here before the
 * payment layer runs.
 *
 * The ONLY source is VERIPAYAI_PAYEES="treasury:0x…,payroll:0x…" — an explicit,
 * operator-configured directory. PayAI ships no built-in payees: it never
 * invents a recipient identity or address. An unconfigured name returns null,
 * and the caller must ask who the recipient is.
 *
 * Every consumer (/api/agent, /api/agent/confirm, /api/schedule,
 * /api/automations, /api/compliance/check) goes through resolvePayee, so this
 * one boundary covers them all.
 */

export interface Payee {
  /** Canonical display name. */
  name: string;
  address: `0x${string}`;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Parse "name:0x…,name:0x…" from env into a lookup. Entries whose address
 *  isn't a full 0x address are dropped, never half-resolved. */
function fromEnv(): Record<string, `0x${string}`> {
  const raw = process.env.VERIPAYAI_PAYEES;
  if (!raw) return {};
  const out: Record<string, `0x${string}`> = {};
  for (const pair of raw.split(",")) {
    const [name, addr] = pair.split(":").map((s) => s.trim());
    if (name && addr && ADDR_RE.test(addr)) {
      out[name.toLowerCase()] = addr as `0x${string}`;
    }
  }
  return out;
}

/** Resolve a name to a configured payee, or null if it isn't configured.
 *  Case-insensitive. Null means "ask who this is" — never substitute. */
export function resolvePayee(name: string): Payee | null {
  const key = name.trim().toLowerCase();
  const payees = fromEnv();
  // Own keys only, so "constructor" / "__proto__" never resolve to anything.
  if (!Object.prototype.hasOwnProperty.call(payees, key)) return null;
  return { name: name.trim(), address: payees[key] };
}

/** All configured payees (for the dashboard / hints). */
export function listPayees(): Payee[] {
  return Object.entries(fromEnv()).map(([name, address]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    address,
  }));
}

export function isAddress(s: string): boolean {
  return ADDR_RE.test(s);
}

/**
 * Whether a recipient an LLM returned is actually present in what the user
 * wrote. The LLM may point at the recipient the user named; it may never
 * supply one. A 0x address must appear verbatim (case-insensitive); a name or
 * .nad domain must appear as a whole phrase (case- and spacing-insensitive).
 */
export function recipientAppearsIn(recipient: string, sources: readonly string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const needle = norm(recipient);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-bounded so "0xabc…" can't match inside a longer hex string and
  // "pay" can't match inside "payroll".
  const re = new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`);
  return sources.some((s) => typeof s === "string" && re.test(norm(s)));
}
