/**
 * Payee directory — resolves a human name ("Alice") to a wallet address.
 *
 * The agent parses a recipient that may be a name or a 0x address. On-chain
 * settlement needs an address, so named payees are resolved here before the
 * payment layer runs. Entries come from a built-in demo set plus an optional
 * env override (VERIPAYAI_PAYEES="alice:0x…,bob:0x…").
 */

export interface Payee {
  /** Canonical display name. */
  name: string;
  address: `0x${string}`;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Built-in demo payees (override / extend via VERIPAYAI_PAYEES). */
const DEFAULTS: Record<string, `0x${string}`> = {
  alice: "0x1111111111111111111111111111111111111111",
  bob: "0x2222222222222222222222222222222222222222",
  carol: "0x3333333333333333333333333333333333333333",
  acme: "0x4444444444444444444444444444444444444444",
};

/** Parse "name:0x…,name:0x…" from env into a lookup. */
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

function table(): Record<string, `0x${string}`> {
  return { ...DEFAULTS, ...fromEnv() };
}

/** Resolve a name to a payee, or null if unknown. Case-insensitive. */
export function resolvePayee(name: string): Payee | null {
  const key = name.trim().toLowerCase();
  const addr = table()[key];
  if (!addr) return null;
  return { name: name.trim(), address: addr };
}

/** All known payees (for the dashboard / hints). */
export function listPayees(): Payee[] {
  return Object.entries(table()).map(([name, address]) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    address,
  }));
}

export function isAddress(s: string): boolean {
  return ADDR_RE.test(s);
}
