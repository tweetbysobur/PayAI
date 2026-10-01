/**
 * The one recipient resolver: a user-supplied recipient string → a concrete
 * 0x address, or a refusal. Same rules every money-moving route applies:
 *
 *   1. a raw 0x address — used as written;
 *   2. a .nad / .nads domain — resolved through the existing NNS resolver
 *      (lib/monad/domain-resolver.ts), which never fabricates an address;
 *   3. a name — ONLY if it is in the operator-configured payee directory
 *      (VERIPAYAI_PAYEES, lib/payees/directory.ts). PayAI ships no payees.
 *
 * Anything else is unresolved, and the caller must ask who the recipient is.
 * There is no fallback address of any kind.
 *
 * Previously a private helper in app/api/automations/route.ts; moved here so
 * split payments (and the future Intent Engine) resolve recipients exactly
 * the same way. Messages are unchanged.
 *
 * Server-only (the .nad path reads the chain).
 */
import "server-only";
import { getAddress } from "viem";
import { isAddress, resolvePayee } from "./directory";
import { extractDomain, isDomainName } from "@/lib/monad/domain-resolver";

export type RecipientResolution =
  | {
      ok: true;
      address: `0x${string}`;
      source: "address" | "nad" | "payee";
      /** What the user wrote, normalized for display (".nad" name or payee name). */
      display: string;
      /** The resolved .nad domain, when that's where the address came from. */
      domain: string | null;
      /** The address exactly as the underlying source returned it (the
       *  user's text, the NNS read, or the configured directory entry). */
      asResolved: string;
    }
  | { ok: false; message: string };

export async function resolveRecipientInput(input: string): Promise<RecipientResolution> {
  const raw = input.trim();
  if (!raw) return { ok: false, message: "Enter a recipient." };
  if (isAddress(raw)) return { ok: true, address: getAddress(raw), source: "address", display: raw, domain: null, asResolved: raw };
  if (isDomainName(raw)) {
    const { resolveDomain } = await import("@/lib/monad/domain-resolver");
    const dom = extractDomain(raw) ?? raw;
    const resolution = await resolveDomain(dom);
    if (!resolution.resolvedAddress) return { ok: false, message: `Couldn't resolve ${dom}. Check the name and try again.` };
    return { ok: true, address: getAddress(resolution.resolvedAddress), source: "nad", display: resolution.domain, domain: resolution.domain, asResolved: resolution.resolvedAddress };
  }
  const payee = resolvePayee(raw);
  if (!payee) return { ok: false, message: `"${raw}" isn't a valid address, .nad domain, or known payee.` };
  return { ok: true, address: getAddress(payee.address), source: "payee", display: payee.name, domain: null, asResolved: payee.address };
}

/** Throwing form, for callers that already report errors via exceptions
 *  (the automations route). Returns each address exactly as its source gave
 *  it, matching that route's prior behavior byte-for-byte. */
export async function resolveRecipient(input: string): Promise<{ recipient: string; domain: string | null }> {
  const r = await resolveRecipientInput(input);
  if (!r.ok) throw new Error(r.message);
  return { recipient: r.asResolved, domain: r.domain };
}
