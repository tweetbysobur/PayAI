"use client";

/**
 * P1.1 — Ask PayAI conversation persistence across a browser refresh.
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
 * storage, different key, same coexistence pattern as the rest of this app's
 * client-side persistence.
 *
 * SECURITY: only ever restores data this module itself wrote (or an empty
 * conversation). Never restores anything that could let a transaction
 * execute without a fresh click through the existing confirm funnel — see
 * sanitizeRestoredMessages, the one place that matters.
 */
import type { AskMessage, Operation } from "@/lib/ask/types";
import type { Understanding } from "@/lib/ask/intent/types";

const STORAGE_KEY = "payai_ask_conversation_v1";

/** Bumped whenever the persisted shape changes incompatibly. An old or
 *  unrecognized version is never partially trusted — see loadChatState. */
const SCHEMA_VERSION = 1;

/** How long a persisted conversation stays valid, measured from the last
 *  time it actually changed (savedAt is rewritten on every save — see
 *  useAskChat's persistence effect — so this is a sliding inactivity window,
 *  not a fixed session start). No existing TTL in this codebase fits a
 *  multi-turn chat: the portfolio cache is 5 minutes (a balance re-check,
 *  not a conversation), a trade quote goes stale in 60 seconds (a price,
 *  not a thread). A day matches how people actually leave a chat tab open —
 *  long enough that an overnight-open tab still resumes normally, short
 *  enough that a "ready to sign" card from days ago (a payment, a trade
 *  quote) doesn't linger indefinitely presenting itself as current. Any
 *  quote inside a restored card is independently re-validated at confirm
 *  time regardless (see useAskChat's isQuoteStale) — this TTL is about the
 *  conversation as a whole, not a substitute for that check. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface PersistedAskChat {
  v: number;
  savedAt: number;
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
 *     (see OperationCard's SubmittedBody) — nothing to downgrade.
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

/** Reads and validates the persisted conversation. Any failure at all —
 *  storage unavailable, malformed JSON, wrong schema version, expired,
 *  wrong shape — returns null and clears whatever was there, so a bad
 *  record can never half-load. Never throws. */
export function loadChatState(): { messages: AskMessage[]; pending: Understanding | null } | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedAskChat>;
    if (parsed.v !== SCHEMA_VERSION) { clearChatState(); return null; }
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > SESSION_TTL_MS) { clearChatState(); return null; }
    if (!looksLikeMessages(parsed.messages)) { clearChatState(); return null; }
    return { messages: sanitizeRestoredMessages(parsed.messages), pending: parsed.pending ?? null };
  } catch {
    // Malformed JSON, or storage unavailable in this environment — either
    // way, never surface a half-parsed conversation. Best-effort clear; if
    // even that throws, there's nothing left to do.
    try { clearChatState(); } catch { /* no-op */ }
    return null;
  }
}

/** Mirrors current conversation state into sessionStorage. Called after
 *  every change (see useAskChat) — savedAt refreshes each time, so the TTL
 *  above tracks time since the conversation was last actually touched, not
 *  since the tab was opened. An empty conversation (nothing sent yet, or
 *  just cleared via "New conversation") is treated as nothing-to-restore
 *  rather than persisted as an empty shell. */
export function saveChatState(messages: AskMessage[], pending: Understanding | null): void {
  try {
    if (messages.length === 0 && pending === null) {
      clearChatState();
      return;
    }
    const record: PersistedAskChat = { v: SCHEMA_VERSION, savedAt: Date.now(), messages, pending };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable (private mode, quota) or unserializable content —
    // the conversation just won't survive a refresh this time; nothing else
    // in the app depends on this write succeeding.
  }
}

export function clearChatState(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no-op */
  }
}
