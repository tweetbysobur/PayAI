"use client";

/**
 * P1.1 — Ask PayAI conversation persistence across a browser refresh.
 * P1.2 — that persistence is wallet-scoped: nothing here is ever restored
 * (or written) except under the wallet that produced it.
 * P1.3 — a wallet can hold MULTIPLE named conversations, not just one: a
 * lightweight per-wallet index (title/timestamps/message count only) backs
 * the ConversationList rail, and each conversation's full transcript lives
 * in its own key, loaded only when actually opened or searched.
 * P1.6 — switched from sessionStorage to localStorage. sessionStorage is
 * cleared the moment a tab is actually closed — including a mobile browser
 * silently closing and later restoring a backgrounded tab under memory
 * pressure, which looks identical to an ordinary refresh from the user's
 * side but wiped the conversation exactly like a real tab close would (the
 * reported bug this fixes). localStorage survives a closed tab and a full
 * browser restart, until "Clear history" is used or the browser's own site
 * data is cleared. Browser-only, no backend, no database.
 *
 * One real behavior change from the switch: localStorage (unlike
 * sessionStorage) IS shared across every tab of the same origin. Two tabs
 * open on the same wallet now read/write the same underlying records —
 * there's still no LIVE push between them (no `storage` event listener
 * here), so a second tab only sees another tab's latest save the next time
 * it itself reads storage (mount, wallet switch, conversation switch), not
 * instantly — but a tab can no longer silently diverge onto its own,
 * permanently separate history the way two sessionStorage tabs used to.
 *
 * Scope is deliberately narrow: the full /dashboard/ask page's conversation
 * (via AskPageChatContext) opts into this; CommandBar's own useAskChat()
 * instance does NOT (see useAskChat's `persist` option) — those are two
 * intentionally separate conversations (see AskPageChatContext's own doc),
 * and sharing one storage key between them would silently merge two threads
 * that were never meant to be the same one.
 *
 * WALLET SCOPING (P1.2, carried forward): every key below is namespaced by
 * wallet address. A single shared record could only ever remember the most
 * recently active wallet, so switching A -> B and back would lose A's data
 * the moment B wrote anything of its own. Per-wallet keys mean each
 * wallet's history survives independently, completely undisturbed by
 * another wallet's activity.
 *
 * SECURITY: only ever restores data this module itself wrote for the EXACT
 * wallet currently connected (or nothing, if no wallet is connected — see
 * normalizeWalletAddress). Never restores anything that could let a
 * transaction execute without a fresh click through the existing confirm
 * funnel — see sanitizeRestoredMessages, the one place that matters. Since
 * localStorage now persists indefinitely (not just for the tab's session),
 * this data also outlives the browser session on a shared/public device
 * until "Clear history" is used or the browser's own site data is cleared.
 */
import type { AskMessage, Operation } from "@/lib/ask/types";
import type { Understanding } from "@/lib/ask/intent/types";

/** Bumped whenever the persisted shape changes incompatibly. An old or
 *  unrecognized version is never partially trusted — see loadHistoryIndex /
 *  loadConversation. This is a NEW version number for the multi-conversation
 *  history model — it is NOT the same schema as P1.1/P1.2's single-
 *  conversation v2 record, and that old record is never silently reinterpreted
 *  as a history list (see migrateLegacyConversation): it's read ONCE, in the
 *  one place its shape is unambiguous (a single conversation becomes the
 *  first entry of a new, empty history), and discarded either way. */
const SCHEMA_VERSION = 1;

const INDEX_KEY_PREFIX = "payai_ask_history_index_v1:";
const CONV_KEY_PREFIX = "payai_ask_history_conv_v1:";

/** P1.1's original single-shared-record key — no wallet association at all.
 *  Removed on sight; never read (see loadHistoryIndex). */
const LEGACY_V1_KEY = "payai_ask_conversation_v1";
/** P1.2's per-wallet, single-conversation key. Superseded by the history
 *  model in this file — read exactly once per wallet (see
 *  migrateLegacyConversation) to migrate whatever was there into the first
 *  entry of a new history list, then retired. Never reinterpreted as a
 *  history index or trusted a second time. */
const LEGACY_V2_KEY_PREFIX = "payai_ask_conversation_v2:";
const LEGACY_V2_SCHEMA_VERSION = 2;
/** Matches P1.1/P1.2's own TTL — only used to decide whether the legacy
 *  record is still fresh enough to be worth migrating, not applied to the
 *  new history model itself (conversations do NOT auto-expire by age; see
 *  MAX_CONVERSATIONS/pruning below for how the list is actually bounded). */
const LEGACY_V2_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard cap on how many conversations one wallet can hold. Reached by
 *  pruning the oldest ELIGIBLE (never the currently active) conversation —
 *  see upsertConversation. Conversations never expire by age on their own;
 *  this count is the only bound. */
export const MAX_CONVERSATIONS = 20;
/** Hard cap on how many messages are actually PERSISTED per conversation —
 *  a storage bound, not a live-chat limit: the in-memory conversation can
 *  grow past this during an active session, but only the newest
 *  MAX_MESSAGES_PER_CONVERSATION are written to sessionStorage each save
 *  (oldest trimmed first). A refresh after that point restores the most
 *  recent 100, not the very first message — an accepted trade-off for
 *  keeping the storage footprint bounded (see this file's own doc on
 *  performance). */
export const MAX_MESSAGES_PER_CONVERSATION = 100;

/** Title length cap — long enough to read as a real sentence fragment,
 *  short enough to fit a compact rail row without wrapping. */
const MAX_TITLE_LEN = 48;

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

function indexKey(normalizedAddress: string): string {
  return `${INDEX_KEY_PREFIX}${normalizedAddress}`;
}
function convKey(normalizedAddress: string, conversationId: string): string {
  return `${CONV_KEY_PREFIX}${normalizedAddress}:${conversationId}`;
}

/** Globally unique regardless of wallet — a rename/delete/keyed-update can
 *  never collide across two different wallets' conversations, and the
 *  async-staleness guard in useAskChat relies on that uniqueness too. */
export function createConversationId(): string {
  return crypto.randomUUID();
}

/** Lightweight — everything the ConversationList rail needs to render a row
 *  WITHOUT loading that conversation's full transcript. This is the whole
 *  performance point: the index is one small JSON blob per wallet; opening a
 *  specific conversation (or searching message text) is the only time a
 *  full record is ever read. */
export interface ConversationSummary {
  conversationId: string;
  walletAddress: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** The full conversation — messages + pending intent context, restored
 *  exactly the way a single P1.1/P1.2 conversation was, just addressable by
 *  its own conversationId now instead of being the one-and-only slot. */
export interface ConversationRecord {
  conversationId: string;
  walletAddress: string;
  title: string;
  /** True once the user has manually renamed this conversation — after
   *  that, the auto-title deriver (see deriveConversationTitle) never
   *  overwrites it again, no matter how the conversation continues. */
  titleIsCustom: boolean;
  createdAt: number;
  updatedAt: number;
  messages: AskMessage[];
  pending: Understanding | null;
}

interface ConversationRecordStored extends ConversationRecord {
  v: number;
}
interface HistoryIndexStored {
  v: number;
  walletAddress: string;
  activeConversationId: string | null;
  summaries: ConversationSummary[];
}

/** The one thing a refresh (or a conversation switch) must never do: leave
 *  an operation looking like a signature or broadcast is still actively in
 *  flight when the real request that would have carried it out is gone.
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
 *   - success/error: already-settled fact, safe to just show. A success
 *     card only ever carries the same sanitized display fields it always
 *     has (txHash/explorerUrl/amount/token/etc.) — never a duplicate copy
 *     of the authoritative transaction/automation record, which stays the
 *     source of truth in lib/platform/store.ts and schedules.ts.
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
 *  back what this module itself wrote (or hand-edited/corrupted garbage),
 *  so the job is to never throw and never trust something that isn't at
 *  least shaped like a message list — not to re-verify every nested Intent
 *  field. Genuinely incompatible shapes are caught by SCHEMA_VERSION. */
function looksLikeMessages(v: unknown): v is AskMessage[] {
  return Array.isArray(v) && v.every((m) => m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" && typeof (m as { role?: unknown }).role === "string" && typeof (m as { content?: unknown }).content === "string" && typeof (m as { createdAt?: unknown }).createdAt === "number");
}
function looksLikeSummary(v: unknown): v is ConversationSummary {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.conversationId === "string" && typeof s.title === "string" && typeof s.createdAt === "number" && typeof s.updatedAt === "number" && typeof s.messageCount === "number";
}

function truncateText(s: string, max: number): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
function shortAddr(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

const FREQUENCY_TITLE: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", custom: "Recurring" };

/** One line per Intent kind, built from that kind's own real fields — never
 *  a single fixed template, which is exactly why a payment title reads
 *  differently from a swap or a token lookup. Returns null for a kind this
 *  doesn't have a natural phrasing for yet, letting the caller fall back to
 *  the user's own words instead of forcing something generic. */
function titleFromIntent(intent: Operation["intent"]): string | null {
  switch (intent.kind) {
    case "payment":
    case "scheduled_payment":
      return `Send ${intent.amount} ${intent.token} to ${intent.recipientDomain ?? shortAddr(intent.recipient)}`;
    case "recurring_payment":
      return `${FREQUENCY_TITLE[intent.frequency] ?? "Recurring"} ${intent.amount} ${intent.token} to ${intent.recipientDomain ?? shortAddr(intent.recipient)}`;
    case "swap":
      return `Swap ${intent.fromToken} for ${intent.toToken}`;
    case "trade_preview":
      return intent.data.action === "buy" ? `Buy ${intent.data.receive.token}` : `Sell ${intent.data.spend.token}`;
    case "token_intelligence":
      return intent.data?.symbol ? `Check ${intent.data.symbol}` : "Check this token";
    case "distribution":
      return `Distribute ${intent.token} to ${intent.recipientCount} recipients`;
    case "wallet_operation":
      if (intent.operation === "balance") return "Check balance";
      if (intent.operation === "recent_payments") return "Recent payments";
      return "Transaction lookup";
    default:
      return null;
  }
}

/**
 * Deterministic conversation title — no Anthropic call, no fixed template.
 * Scans from the START of the conversation for the first operation card
 * whose Intent kind has a natural phrasing (see titleFromIntent); once one
 * exists, this always finds the SAME one on every later call (it never
 * looks at the newest message), so the title naturally stabilizes the
 * moment real structured data exists and never has to be explicitly
 * "locked" — the caller only needs to stop calling this once the user
 * manually renames (see ConversationRecord's titleIsCustom).
 *
 * Falls back to the user's own first non-empty message, trimmed and
 * truncated, for anything before an operation resolves (plain chat, an
 * unclear/unsupported reply, or a pasted address still being looked up).
 */
export function deriveConversationTitle(messages: AskMessage[]): string {
  for (const m of messages) {
    if (m.operation) {
      const t = titleFromIntent(m.operation.intent);
      if (t) return truncateText(t, MAX_TITLE_LEN);
    }
  }
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim().length > 0);
  if (firstUser) return capitalize(truncateText(firstUser.content, MAX_TITLE_LEN));
  return "New conversation";
}

function sortByRecency(summaries: ConversationSummary[]): ConversationSummary[] {
  return [...summaries].sort((a, b) => b.updatedAt - a.updatedAt);
}

function tryWriteJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage unavailable (private mode) or quota exceeded — callers handle
    // quota specifically with a bounded retry (see upsertConversation);
    // this never throws a user-facing error either way.
    return false;
  }
}

function removeConv(normalized: string, conversationId: string): void {
  try { localStorage.removeItem(convKey(normalized, conversationId)); } catch { /* no-op */ }
}

/** Reads the raw index for a wallet with light structural validation —
 *  wrong schema version, wrong wallet, or a malformed summaries array all
 *  return null (and best-effort clear the key) rather than partially trust
 *  it. Does NOT attempt migration — that's loadHistoryIndex's job, the one
 *  public entry point everything else in this file builds on. */
function readIndexRaw(normalized: string): HistoryIndexStored | null {
  try {
    const raw = localStorage.getItem(indexKey(normalized));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HistoryIndexStored>;
    if (parsed.v !== SCHEMA_VERSION) { try { localStorage.removeItem(indexKey(normalized)); } catch { /* no-op */ } return null; }
    if (normalizeWalletAddress(parsed.walletAddress) !== normalized) { try { localStorage.removeItem(indexKey(normalized)); } catch { /* no-op */ } return null; }
    if (!Array.isArray(parsed.summaries) || !parsed.summaries.every(looksLikeSummary)) { try { localStorage.removeItem(indexKey(normalized)); } catch { /* no-op */ } return null; }
    return {
      v: SCHEMA_VERSION, walletAddress: normalized,
      activeConversationId: typeof parsed.activeConversationId === "string" ? parsed.activeConversationId : null,
      summaries: parsed.summaries,
    };
  } catch {
    try { localStorage.removeItem(indexKey(normalized)); } catch { /* no-op */ }
    return null;
  }
}

/**
 * One-time, best-effort migration of P1.1/P1.2's single-conversation v2
 * record into the first entry of a brand-new history list — only when the
 * mapping is completely unambiguous (a valid single conversation becomes a
 * single new conversation). Anything short of fully valid (wrong version,
 * expired past the OLD ttl, wallet mismatch, malformed messages, or simply
 * empty) is discarded instead — never partially trusted, never silently
 * reinterpreted as if it were already a history list. The legacy key is
 * removed either way: it is read exactly once, ever, per wallet.
 */
function migrateLegacyConversation(normalized: string): { activeConversationId: string | null; summaries: ConversationSummary[] } | null {
  const legacyKey = `${LEGACY_V2_KEY_PREFIX}${normalized}`;
  let legacyMessages: AskMessage[] | null = null;
  let legacyPending: Understanding | null = null;
  let legacySavedAt: number | null = null;
  try {
    const raw = localStorage.getItem(legacyKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; walletAddress?: unknown; messages?: unknown; pending?: unknown };
      if (
        parsed.v === LEGACY_V2_SCHEMA_VERSION &&
        typeof parsed.savedAt === "number" && Date.now() - parsed.savedAt <= LEGACY_V2_TTL_MS &&
        normalizeWalletAddress(parsed.walletAddress as string | null | undefined) === normalized &&
        looksLikeMessages(parsed.messages)
      ) {
        legacyMessages = parsed.messages;
        legacyPending = (parsed.pending as Understanding | null) ?? null;
        legacySavedAt = parsed.savedAt;
      }
    }
  } catch {
    // Malformed — nothing to migrate.
  }
  try { localStorage.removeItem(legacyKey); } catch { /* no-op */ }

  if (!legacyMessages || legacyMessages.length === 0 || legacySavedAt === null) return null;

  const conversationId = createConversationId();
  const sanitized = sanitizeRestoredMessages(legacyMessages);
  const title = deriveConversationTitle(sanitized);
  const record: ConversationRecordStored = {
    v: SCHEMA_VERSION, conversationId, walletAddress: normalized, title, titleIsCustom: false,
    createdAt: legacySavedAt, updatedAt: legacySavedAt, messages: sanitized, pending: legacyPending,
  };
  const summary: ConversationSummary = { conversationId, walletAddress: normalized, title, createdAt: legacySavedAt, updatedAt: legacySavedAt, messageCount: sanitized.length };
  tryWriteJson(convKey(normalized, conversationId), record);
  tryWriteJson(indexKey(normalized), { v: SCHEMA_VERSION, walletAddress: normalized, activeConversationId: conversationId, summaries: [summary] });
  return { activeConversationId: conversationId, summaries: [summary] };
}

/**
 * The one public entry point for reading a wallet's conversation list.
 * Validates and (if nothing valid exists yet) attempts the one-time legacy
 * migration above. Never throws; a wallet with no history at all (new
 * wallet, cleared history, or an old record that didn't survive validation)
 * simply gets an empty list, never someone else's.
 */
export function loadHistoryIndex(walletAddress: string | null): { activeConversationId: string | null; summaries: ConversationSummary[] } {
  // Best-effort cleanup of P1.1's original wallet-unaware key — see its own
  // constant doc. Never read, only removed on sight.
  try { localStorage.removeItem(LEGACY_V1_KEY); } catch { /* no-op */ }

  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return { activeConversationId: null, summaries: [] };

  const existing = readIndexRaw(normalized);
  if (existing) return { activeConversationId: existing.activeConversationId, summaries: sortByRecency(existing.summaries) };

  const migrated = migrateLegacyConversation(normalized);
  return migrated ?? { activeConversationId: null, summaries: [] };
}

/**
 * Reads and validates ONE full conversation. Any failure — storage
 * unavailable, malformed JSON, wrong schema version, wallet mismatch, id
 * mismatch, or wrong shape — returns null and clears that one record, never
 * half-loading it. Restored operations are sanitized exactly like P1.1/P1.2
 * (see sanitizeOperation) — this is the one path both a wallet switch AND a
 * conversation switch both go through, so neither can ever resurrect a
 * "confirming" card as executable.
 */
export function loadConversation(walletAddress: string | null, conversationId: string): ConversationRecord | null {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return null;
  try {
    const raw = localStorage.getItem(convKey(normalized, conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConversationRecordStored>;
    if (parsed.v !== SCHEMA_VERSION) { removeConv(normalized, conversationId); return null; }
    if (normalizeWalletAddress(parsed.walletAddress) !== normalized) { removeConv(normalized, conversationId); return null; }
    if (parsed.conversationId !== conversationId) { removeConv(normalized, conversationId); return null; }
    if (typeof parsed.title !== "string" || typeof parsed.createdAt !== "number" || typeof parsed.updatedAt !== "number") { removeConv(normalized, conversationId); return null; }
    if (!looksLikeMessages(parsed.messages)) { removeConv(normalized, conversationId); return null; }
    return {
      conversationId, walletAddress: normalized, title: parsed.title, titleIsCustom: !!parsed.titleIsCustom,
      createdAt: parsed.createdAt, updatedAt: parsed.updatedAt,
      messages: sanitizeRestoredMessages(parsed.messages), pending: parsed.pending ?? null,
    };
  } catch {
    try { removeConv(normalized, conversationId); } catch { /* no-op */ }
    return null;
  }
}

/**
 * Writes one conversation's full record AND updates the wallet's index in
 * the same call — messages are capped to the newest MAX_MESSAGES_PER_CONVERSATION
 * before writing (oldest trimmed first), and the index is pruned to
 * MAX_CONVERSATIONS by dropping the oldest-updated ELIGIBLE conversation
 * (never the one currently active — see the eligibility filter below,
 * satisfying "never silently delete the currently active conversation").
 * A quota failure at either write is retried once with a more aggressive
 * trim/prune before giving up silently — this never throws a user-facing
 * error, and a failed setItem never partially writes in the first place, so
 * the active conversation can never end up corrupted, only (in the worst
 * case) not-yet-persisted for this particular change.
 */
export function upsertConversation(
  walletAddress: string | null,
  input: { conversationId: string; title: string; titleIsCustom: boolean; createdAt: number; updatedAt: number; messages: AskMessage[]; pending: Understanding | null },
): ConversationSummary[] {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return [];

  const cappedMessages = input.messages.length > MAX_MESSAGES_PER_CONVERSATION
    ? input.messages.slice(input.messages.length - MAX_MESSAGES_PER_CONVERSATION)
    : input.messages;

  const index = readIndexRaw(normalized) ?? { v: SCHEMA_VERSION, walletAddress: normalized, activeConversationId: null, summaries: [] };
  const summary: ConversationSummary = {
    conversationId: input.conversationId, walletAddress: normalized, title: input.title,
    createdAt: input.createdAt, updatedAt: input.updatedAt, messageCount: cappedMessages.length,
  };
  let nextSummaries = [...index.summaries.filter((s) => s.conversationId !== input.conversationId), summary];
  const nextActive = input.conversationId;

  const prunedIds: string[] = [];
  while (nextSummaries.length > MAX_CONVERSATIONS) {
    const eligible = nextSummaries
      .filter((s) => s.conversationId !== nextActive)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!eligible) break; // nothing eligible left to prune (shouldn't happen with a cap > 1)
    nextSummaries = nextSummaries.filter((s) => s.conversationId !== eligible.conversationId);
    prunedIds.push(eligible.conversationId);
  }

  const record: ConversationRecordStored = {
    v: SCHEMA_VERSION, conversationId: input.conversationId, walletAddress: normalized,
    title: input.title, titleIsCustom: input.titleIsCustom, createdAt: input.createdAt, updatedAt: input.updatedAt,
    messages: cappedMessages, pending: input.pending,
  };
  if (!tryWriteJson(convKey(normalized, input.conversationId), record)) {
    // Quota pressure — retry once with an aggressively trimmed transcript
    // rather than giving up on saving this conversation entirely. Still
    // never partially written: setItem either fully succeeds or throws.
    tryWriteJson(convKey(normalized, input.conversationId), { ...record, messages: cappedMessages.slice(-20) });
  }
  for (const id of prunedIds) removeConv(normalized, id);

  const nextIndex: HistoryIndexStored = { v: SCHEMA_VERSION, walletAddress: normalized, activeConversationId: nextActive, summaries: nextSummaries };
  if (!tryWriteJson(indexKey(normalized), nextIndex)) {
    // Quota pressure on the index itself — drop one more oldest, non-active
    // conversation (and its record) and retry once before giving up.
    const fallback = nextSummaries.filter((s) => s.conversationId !== nextActive).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (fallback) {
      nextSummaries = nextSummaries.filter((s) => s.conversationId !== fallback.conversationId);
      removeConv(normalized, fallback.conversationId);
      tryWriteJson(indexKey(normalized), { ...nextIndex, summaries: nextSummaries });
    }
  }
  return sortByRecency(nextSummaries);
}

/** Persists which conversation is active without touching its content —
 *  used when merely opening/switching, not when its messages change. */
export function setActiveConversationPointer(walletAddress: string | null, conversationId: string | null): void {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return;
  const index = readIndexRaw(normalized) ?? { v: SCHEMA_VERSION, walletAddress: normalized, activeConversationId: null, summaries: [] };
  tryWriteJson(indexKey(normalized), { ...index, activeConversationId: conversationId });
}

/** Renames a conversation and marks its title custom, so the auto-deriver
 *  never overwrites it again. Deliberately does NOT bump `updatedAt` — a
 *  rename is a metadata edit, not new conversation activity, so it doesn't
 *  reorder the "Recent" list the way actually chatting does. */
export function renameConversation(walletAddress: string | null, conversationId: string, title: string): ConversationSummary[] {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return [];
  const trimmedTitle = truncateText(title, MAX_TITLE_LEN) || "Untitled conversation";
  const record = loadConversation(normalized, conversationId);
  const index = readIndexRaw(normalized);
  if (!record || !index) return index ? sortByRecency(index.summaries) : [];
  const updatedRecord: ConversationRecordStored = { v: SCHEMA_VERSION, ...record, title: trimmedTitle, titleIsCustom: true };
  tryWriteJson(convKey(normalized, conversationId), updatedRecord);
  const nextSummaries = index.summaries.map((s) => (s.conversationId === conversationId ? { ...s, title: trimmedTitle } : s));
  tryWriteJson(indexKey(normalized), { ...index, summaries: nextSummaries });
  return sortByRecency(nextSummaries);
}

/** Deletes one conversation's record and its index entry. Never touches any
 *  other wallet's data, never touches the authoritative transaction/
 *  automation stores (this is a UI record, not the source of truth for
 *  either — see lib/platform/store.ts / schedules.ts). Returns the
 *  conversation list afterward, and the new activeConversationId (null if
 *  the deleted one WAS active — the caller falls back to a fresh
 *  conversation exactly like "New conversation" in that case). */
export function deleteConversation(walletAddress: string | null, conversationId: string): { summaries: ConversationSummary[]; activeConversationId: string | null } {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return { summaries: [], activeConversationId: null };
  removeConv(normalized, conversationId);
  const index = readIndexRaw(normalized);
  if (!index) return { summaries: [], activeConversationId: null };
  const nextSummaries = index.summaries.filter((s) => s.conversationId !== conversationId);
  const nextActive = index.activeConversationId === conversationId ? null : index.activeConversationId;
  tryWriteJson(indexKey(normalized), { ...index, summaries: nextSummaries, activeConversationId: nextActive });
  return { summaries: sortByRecency(nextSummaries), activeConversationId: nextActive };
}

/** Wipes every conversation for one wallet — the "Clear history" action.
 *  Removes each conversation's own record plus the index itself; never
 *  touches another wallet's keys, and never touches on-chain data or the
 *  automation store. */
export function clearAllHistory(walletAddress: string | null): void {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return;
  const index = readIndexRaw(normalized);
  if (index) for (const s of index.summaries) removeConv(normalized, s.conversationId);
  try { localStorage.removeItem(indexKey(normalized)); } catch { /* no-op */ }
}

/**
 * Local-only search over one wallet's conversations — matches title first
 * (cheap, index-only), then falls back to loading full transcripts ONLY for
 * conversations that didn't already match by title, checking message text.
 * No backend, no separate search index; with a 20-conversation cap this is
 * at most 20 small sessionStorage reads, done lazily (only when the caller
 * actually has a query), never on every render.
 */
export function searchConversations(walletAddress: string | null, query: string): ConversationSummary[] {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized) return [];
  const index = readIndexRaw(normalized);
  const summaries = index ? sortByRecency(index.summaries) : [];
  const q = query.trim().toLowerCase();
  if (!q) return summaries;
  return summaries.filter((s) => {
    if (s.title.toLowerCase().includes(q)) return true;
    const record = loadConversation(normalized, s.conversationId);
    return !!record?.messages.some((m) => m.content.toLowerCase().includes(q));
  });
}
