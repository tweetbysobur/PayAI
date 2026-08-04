/**
 * PayAI usernames — the default identity inside PayAI.
 *
 * Every wallet gets a readable handle like `@gentle-otter` the moment it
 * exists, with no signup step and nothing to store: the default is DERIVED
 * from the address, so it is stable across devices and sessions by
 * construction. Storage is only touched when someone actually changes theirs,
 * which keeps the common case free and means a KV outage can never leave a
 * user without an identity.
 *
 * Deliberately not a global namespace with reservations and collisions — two
 * wallets can hold the same handle. Resolution therefore always prefers an
 * exact address or Monad name, and a handle is a display convenience plus a
 * lookup hint, never an authority for where money goes. Making handles
 * authoritative for payments would create a squatting and impersonation
 * surface that a beta payment app has no business shipping.
 */

/** Word lists chosen to read as friendly and neutral — no finance jargon, no
 *  crypto in-jokes, nothing that could read as a slur or a claim. */
const ADJECTIVES = [
  "gentle", "swift", "bright", "calm", "clever", "brave", "quiet", "keen",
  "warm", "sharp", "kind", "steady", "bold", "clear", "eager", "fair",
  "glad", "noble", "prime", "quick", "solid", "sunny", "true", "wise",
] as const;

const NOUNS = [
  "otter", "falcon", "cedar", "harbor", "meadow", "comet", "lantern", "willow",
  "atlas", "beacon", "canyon", "delta", "ember", "forest", "glacier", "haven",
  "island", "juniper", "kestrel", "lagoon", "maple", "north", "orchid", "pilot",
] as const;

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;
const RESERVED = new Set([
  "payai", "admin", "support", "help", "team", "official", "system", "root",
  "security", "billing", "wallet", "monad", "null", "undefined", "anonymous",
]);

/** Small deterministic hash — only needs to spread addresses evenly across
 *  the word lists, not to resist anything. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The handle a wallet has until its owner changes it. Pure function of the
 * address: same wallet, same handle, on any device, with nothing persisted.
 */
export function defaultUsername(address: string): string {
  const h = hash(address.toLowerCase());
  const adjective = ADJECTIVES[h % ADJECTIVES.length];
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length];
  // A short address-derived suffix keeps collisions rare without making the
  // handle look machine-generated.
  const suffix = address.toLowerCase().slice(-3);
  return `${adjective}-${noun}-${suffix}`;
}

export interface UsernameCheck {
  ok: boolean;
  /** Present when ok is false — plain language, safe to show directly. */
  error?: string;
}

/** Validates a handle a user typed. Rules kept obvious so the error can say
 *  exactly what to fix. */
export function validateUsername(raw: string): UsernameCheck {
  const name = raw.trim().toLowerCase().replace(/^@/, "");
  if (name.length < 3) return { ok: false, error: "Usernames need at least 3 characters." };
  if (name.length > 20) return { ok: false, error: "Usernames can be at most 20 characters." };
  if (!HANDLE_RE.test(name)) {
    return { ok: false, error: "Use lowercase letters, numbers and hyphens only, starting and ending with a letter or number." };
  }
  if (RESERVED.has(name)) return { ok: false, error: "That username is reserved. Please pick another." };
  return { ok: true };
}

/** Strips a leading @ and lowercases, so "@Gentle" and "gentle" are one thing. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, "");
}

/** Display form, always with the @. */
export function formatUsername(name: string): string {
  return `@${normalizeUsername(name)}`;
}

/**
 * The exact message a wallet must sign to change its username. Shared by the
 * client that produces the signature and the route that verifies it, so the
 * two can never drift apart. Naming both the address and the new handle stops
 * a captured signature being replayed onto a different name.
 */
export function renameMessage(address: string, username: string): string {
  return `Set my PayAI username to @${normalizeUsername(username)}\n\nWallet: ${address.toLowerCase()}`;
}
