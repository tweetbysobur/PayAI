/**
 * PayAI usernames — a readable identity a user chooses for themselves.
 *
 * Deliberately NOT auto-assigned. A generated handle is nobody's name: people
 * don't recognise it, don't share it, and end up changing it anyway. Until
 * someone picks one, PayAI shows their shortened address, which is honest and
 * unambiguous. Onboarding offers the choice; nothing forces it.
 *
 * Usernames are UNIQUE and first-come, first-served. Once a handle is claimed
 * it is unavailable to anyone else, because the whole point of a name in a
 * payments product is that it identifies one person — a handle two wallets
 * could share would be an impersonation tool, not an identity.
 */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_-]{1,18}[a-z0-9])$/;

/**
 * Names nobody may claim. Two groups, both about impersonation:
 * official-sounding words that could be used to pose as PayAI itself, and
 * finance/authority words that could make a stranger look like staff.
 */
const RESERVED = new Set([
  "payai", "pay-ai", "payai-official", "official", "admin", "administrator",
  "support", "help", "helpdesk", "team", "staff", "system", "root", "moderator",
  "security", "billing", "payments", "payment", "wallet", "wallets", "treasury",
  "monad", "founder", "ceo", "owner", "verified", "announcement", "announcements",
  "null", "undefined", "anonymous", "me", "you", "everyone", "here", "all",
  "api", "www", "app", "dashboard", "settings", "login", "signup", "auth",
]);

/** Reserved words reduced to their skeletons once at module load, so a
 *  look-alike is caught by the same comparison that catches the real word. */
const RESERVED_SKELETONS = new Set<string>();

export interface UsernameCheck {
  ok: boolean;
  /** Present when ok is false — plain language, safe to show directly. */
  error?: string;
}

/** Strips a leading @ and lowercases, so "@Gentle" and "gentle" are one thing. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, "");
}

/** Display form, always with the @. */
export function formatUsername(name: string): string {
  return `@${normalizeUsername(name)}`;
}

/**
 * Collapses characters that look alike so near-identical handles can't be
 * used to impersonate an existing one — `pay1ai` vs `payai`, `s0bur` vs
 * `sobur`. Two names with the same skeleton are treated as the same claim.
 */
export function confusableSkeleton(name: string): string {
  return normalizeUsername(name)
    .replace(/[_-]/g, "")
    .replace(/[0]/g, "o")
    .replace(/[1il]/g, "l")
    .replace(/[3]/g, "e")
    .replace(/[4]/g, "a")
    .replace(/[5]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[8]/g, "b");
}

for (const word of RESERVED) RESERVED_SKELETONS.add(confusableSkeleton(word));

/** Validates a handle a user typed. Rules kept obvious so the error can say
 *  exactly what to fix. */
export function validateUsername(raw: string): UsernameCheck {
  const name = normalizeUsername(raw);
  if (name.length < 3) return { ok: false, error: "Usernames need at least 3 characters." };
  if (name.length > 20) return { ok: false, error: "Usernames can be at most 20 characters." };
  if (!HANDLE_RE.test(name)) {
    return {
      ok: false,
      error: "Use lowercase letters, numbers, hyphens and underscores only, starting and ending with a letter or number.",
    };
  }
  // Compare skeleton-to-skeleton. Comparing a skeleton against the raw
  // reserved words would never match: "pay4i" reduces to "payal", which is
  // not literally in the list even though "payai" reduces to it too.
  if (RESERVED.has(name) || RESERVED_SKELETONS.has(confusableSkeleton(name))) {
    return { ok: false, error: "That username is reserved. Please choose another." };
  }
  return { ok: true };
}

/**
 * The exact message a wallet must sign to claim a username. Shared by the
 * client that produces the signature and the route that verifies it, so the
 * two can never drift apart. Naming both the address and the handle stops a
 * captured signature being replayed onto a different name or wallet.
 */
export function renameMessage(address: string, username: string): string {
  return `Claim the PayAI username @${normalizeUsername(username)}\n\nWallet: ${address.toLowerCase()}`;
}

/** What PayAI shows for a wallet that hasn't chosen a handle yet. Honest and
 *  unambiguous — never a placeholder that looks like a name. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
