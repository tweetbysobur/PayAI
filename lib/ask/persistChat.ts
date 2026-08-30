"use client";

/**
 * P1.1 — Ask PayAI conversation persistence across a browser refresh.
 * P1.2 — that persistence is wallet-scoped: nothing here is ever restored
 * (or written) except under the wallet that produced it.
 *
 * Scope is deliberately narrow: the full /dashboard/ask page's conversation
 * (via AskPageChatContext) opts into this; CommandBar's own useAskChat()
 * instance does NOT (see useAskChat's `persist` option) — those are two
 * intentionally separate conversations (see AskPageChatContext's own doc),
 * and sharing one storage key between them would silently merge two threads
 * that were never meant to be the same one.
 *
 * sessionStorage, not localStorage: this is a per-tab conversation, not a
 * cross-session record like lib/hooks/pendingSettlement.ts's broadcast-
 * recovery data (which genuinely needs to survive a closed tab — see that
 * file's own doc for why it deliberately chose localStorage). Different
 * storage, different key(s), same coexistence pattern as the rest of this
 * app's client-side persistence.
 *
 * WALLET SCOPING (P1.2): one sessionStorage key PER wallet address, rather
 * than one shared record — see storageKey(). A single shared record could
 * only ever remember the most recently active wallet, so switching A -> B
 * and back would lose A's conversation the moment B wrote anything of its
 * own. Per-wallet keys mean each wallet's history survives independently,
 * completely undisturbed by another wallet's activity in the same tab — the
 * WALLET SWITCH behavior this exists to guarantee. The record ALSO carries
 * its own `walletAddress` field (belt-and-suspenders): loadChatState cross-
 * checks it against the key before trusting anything, so a hand-edited
 * record or a future key-scheme change can never silently serve one
 * identity's data under another's.
 *
 * SECURITY: only ever restores data this module itself wrote for the EXACT
 * wallet currently connected (or nothing, if no wallet is connected — see
 * normalizeWalletAddress). Never restores anything that could let a
 * transaction execute without a fresh click through the existing confirm
 * funnel — see sanitizeRestoredMessages, the one place that matters.
 */
import type { AskMessage, Operation } from "@/lib/ask/types";
import type { Understanding } from "@/lib/ask/intent/types";

const STORAGE_KEY_PREFIX = "payai_ask_conversation_v2:";

/** P1.1's original storage key — a single record with no wallet association
 *  at all. Per P1.2, that makes it impossible to trust safely (there's no
 *  identity to check it against), so it's never read, only removed on sight
 *  — see loadChatState. Kept as a named constant purely so that cleanup is
 *  self-documenting rather than a bare string literal. */
const LEGACY_V1_KEY = "payai_ask_conversation_v1";

/** Bumped whenever the persisted shape changes incompatibly. An old or
 *  unrecognized version is never partially trusted — see loadChatState.
 *  Bumped to 2 for P1.2: a v1 record has no `walletAddress` field at all,
 *  so it must never be treated as if it belonged to whichever wallet
 *  happens to be connected now. */
const SCHEMA_VERSION = 2;

/** How long a persisted conversation stays valid, measured from the last
 *  time it actually changed (savedAt is rewritten on every save — see
 *  useAskChat's persistence effect — so this is a sliding inactivity window,
 *  not a fixed session start). Unchanged from P1.1: no existing TTL in this
 *  codebase fits a multi-turn chat (the portfolio cache is 5 minutes, a
 *  trade quote goes stale in 60 seconds), and a day still matches how people
 *  actually leave a chat tab open. Applies per-wallet — each wallet's own
 *  record ages out independently. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The one place "what counts as a real wallet identity" is decided —
 *  lowercased for a stable key/comparison regardless of the checksum
 *  casing a wallet or provider happens to report. Anything that isn't a
 *  string shaped like an address (including null/undefined — no wallet
 *  connected) returns null, which every function below treats as "no known
 *  identity to persist under." */
export function normalizeWalletAddress(address: string | null | undefined): string | null {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) return null;
  return address.toLowerCase();
}

function storageKey(normalizedAddress: string): string {
  return `${STORAGE_KEY_PREFIX}${normalizedAddress}`;
}

interface PersistedAskChat {
  v: number;
  savedAt: number;
  walletAddress: string;
  messages: AskMessage[];
  pending: Understanding | null;
}

/** The one thing a refresh must never do: leave an operation looking like a
 *  signature or broadcast is still actively in flight when the real request
 *  that would have carried it out is gone (killed by the refresh itself).
 *  "confirming" is exactly that state — restoring it as-is would either show
 *  a permanently stuck spinner or, worse, invite retrying into a duplicate
 *  signature for a transaction that may already have broadcast. Every other
 *  status is safe to restore verbatim:
 *   - preview/ready: no signature has happened yet — the existing confirm
 *     funnel (an explicit click, then the existing stale-quote re-check)
 *     still gates everything past this point exactly as it does today.
 *   - submitted: already the intentionally-terminal, informational state
 *     (see OperationCard's SubmittedBody) — nothing to downgrade, and the
 *     existing settlement reconciliation is what actually resolves it.
 *   - success/error: already-settled fact, safe to just show.
 */
function sanitizeOperation(op: Operation): Operation {
  if (op.status !== "confirming") return op;
  return {
    ...op,
    status: "error",
    error: {
      message: "This was interrupted before it finished, so nothing here should be trusted as in progress. If you already approved it in your wallet, check the transaction there first — otherwise it's safe to try again.",
      code: "INTERRUPTED",
    },
  };
}

function sanitizeRestoredMessages(messages: AskMessage[]): AskMessage[] {
  return messages.map((m) => (m.operation ? { ...m, operation: sanitizeOperation(m.operation) } : m));
}

/** Light structural check, not a full schema validator: this only ever reads
 *  back what saveChatState itself wrote (or hand-edited/corrupted garbage),
 *  so the job is to never throw and never trust something that isn't at
 *  least shaped like a message list — not to re-verify every nested Intent
 *  field. Genuinely incompatible shapes are caught by SCHEMA_VERSION. */
function looksLikeMessages(v: unknown): v is AskMessage[] {
  return Array.isArray(v) && v.every((m) => m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" && typeof (m as { role?: unknown }).role === "string" && typeof (m as { content?: unknown }).content === "string" && typeof (m as { createdAt?: unknown }).createdAt === "number");
}

/**
 * Reads and validates the conversation persisted for ONE specific wallet.
 * Any failure at all — storage unavailable, malformed JSON, wrong schema
 * version, expired, wrong shape, or a `walletAddress` inside the record that
 * doesn't match the one being asked for — returns null and clears whatever
 * was there, so a bad or mismatched record can never half-load or leak
 * across identities. Never throws.
 *
 * `walletAddress` must be the CURRENTLY CONNECTED wallet — callers never
 * pass an arbitrary address to go looking up someone else's conversation;
 * see useAskChat, the only real caller, which only ever loads for
 * `wallet.address` at the moment it's asking.
 */
export function loadChatState(walletAddress: string | null): { messages: AskMessage[]; pending: Understanding | null } | null {
  // Best-effort cleanup of the old, wallet-unaware v1 record on every load
  // attempt — it has no wallet association at all, so it can never be
  // safely attributed to whoever is connected now (see this file's own
  // doc). Simplest to just remove it rather than leave it as permanent,
  // never-read clutter. Never throws even if storage is unavailable.
  try { sessionStorage.removeItem(LEGACY_V1_KEY); } catch { /* no-op */ }

  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return null; // no connected wallet — nothing to associate this with

  try {
    const raw = sessionStorage.getItem(storageKey(normalized));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedAskChat>;
    if (parsed.v !== SCHEMA_VERSION) { clearChatState(normalized); return null; }
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > SESSION_TTL_MS) { clearChatState(normalized); return null; }
    if (normalizeWalletAddress(parsed.walletAddress) !== normalized) { clearChatState(normalized); return null; }
    if (!looksLikeMessages(parsed.messages)) { clearChatState(normalized); return null; }
    return { messages: sanitizeRestoredMessages(parsed.messages), pending: parsed.pending ?? null };
  } catch {
    // Malformed JSON, or storage unavailable in this environment — either
    // way, never surface a half-parsed conversation. Best-effort clear; if
    // even that throws, there's nothing left to do.
    try { clearChatState(normalized); } catch { /* no-op */ }
    return null;
  }
}

/**
 * Mirrors current conversation state into sessionStorage, under the given
 * wallet's own key. `walletAddress: null` (no wallet connected) is a no-op —
 * this is the enforcement point for "never associate state with an unknown
 * identity": there is no key an unconnected session could safely write to,
 * so it simply doesn't persist anything until a real wallet is connected.
 * savedAt refreshes on every call, so the TTL above tracks time since THIS
 * wallet's conversation was last actually touched. An empty conversation
 * (nothing sent yet, or just cleared via "New conversation") is treated as
 * nothing-to-restore rather than persisted as an empty shell.
 */
export function saveChatState(messages: AskMessage[], pending: Understanding | null, walletAddress: string | null): void {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return;
  try {
    if (messages.length === 0 && pending === null) {
      clearChatState(normalized);
      return;
    }
    const record: PersistedAskChat = { v: SCHEMA_VERSION, savedAt: Date.now(), walletAddress: normalized, messages, pending };
    sessionStorage.setItem(storageKey(normalized), JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode, quota) or unserializable content —
    // the conversation just won't survive a refresh this time; nothing else
    // in the app depends on this write succeeding.
  }
}

export function clearChatState(walletAddress: string | null): void {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return;
  try {
    sessionStorage.removeItem(storageKey(normalized));
  } catch {
    /* no-op */
  }
}
