"use client";

/**
 * P1.3 — the compact conversation history rail, living INSIDE the Ask PayAI
 * workspace (see app/dashboard/ask/page.tsx) rather than as a new top-level
 * dashboard nav item — there is exactly one "Ask PayAI" entry in Sidebar.tsx,
 * and this stays a panel within that page, not a second surface. The
 * conversation itself remains the dominant element: this rail is narrow,
 * collapsible, and never wider than it needs to be to show a title and a
 * timestamp per row.
 *
 * Purely a view over what lib/ask/useAskChat.ts already exposes — every
 * action here (new/open/rename/delete/clear/search) just calls straight
 * through to the hook, which owns all the actual wallet-scoping and safety
 * rules (see persistChat.ts). This component makes no storage decisions of
 * its own.
 */
import { useMemo, useRef, useState } from "react";
import { Check, MessageSquarePlus, Pencil, Search, Trash2, X } from "lucide-react";
import { timeAgo } from "@/lib/hooks/useAgentConsole";
import type { ConversationSummary } from "@/lib/ask/persistChat";

/** How many of the most-recently-updated conversations count as "Recent" —
 *  a simple, deterministic split (not a time window, which could leave
 *  "Recent" empty on a quiet day) that still reads naturally for a rail
 *  capped at 20 conversations total. */
const RECENT_COUNT = 5;

function ConversationRow({
  conversation, isActive, onOpen, onRename, onDelete,
}: {
  conversation: ConversationSummary;
  isActive: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);

  function commitRename() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== conversation.title) onRename(trimmed);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-primary/40 bg-input/40 px-2 py-1.5">
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { setDraft(conversation.title); setEditing(false); }
          }}
          onBlur={commitRename}
          className="min-w-0 flex-1 bg-transparent text-xs font-medium text-foreground outline-none"
          aria-label="Rename conversation"
        />
        <button onClick={commitRename} aria-label="Save name" className="shrink-0 text-primary-ink hover:opacity-80">
          <Check size={13} />
        </button>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${
        isActive ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-input/40 hover:text-foreground"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{conversation.title}</p>
        <p className="truncate text-[10px] text-muted-foreground">{timeAgo(conversation.updatedAt)}</p>
      </div>
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          onClick={(e) => { e.stopPropagation(); setDraft(conversation.title); setEditing(true); }}
          aria-label="Rename conversation"
          className="rounded p-1 text-muted-foreground hover:bg-input hover:text-foreground"
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          aria-label="Delete conversation"
          className="rounded p-1 text-muted-foreground hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

export function ConversationList({
  conversations,
  activeConversationId,
  onNewConversation,
  onOpenConversation,
  onRenameConversation,
  onDeleteConversation,
  onClearHistory,
  onSearch,
  onClose,
}: {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onNewConversation: () => void;
  onOpenConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
  onClearHistory: () => void;
  /** Local-only search — see useAskChat's searchConversationsAction. Called
   *  on every keystroke; cheap even at the 20-conversation cap. */
  onSearch: (query: string) => ConversationSummary[];
  /** Present only on layouts where the rail can be closed (mobile) — omitted
   *  on desktop, where it's just always-visible in its collapsed/expanded
   *  state instead. */
  onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);

  const results = useMemo(() => (query.trim() ? onSearch(query) : conversations), [query, conversations, onSearch]);
  const recent = results.slice(0, RECENT_COUNT);
  const older = results.slice(RECENT_COUNT);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</p>
        {onClose && (
          <button onClick={onClose} aria-label="Close conversation history" className="rounded p-1 text-muted-foreground hover:bg-input hover:text-foreground">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="shrink-0 px-3 pb-2">
        <button
          onClick={onNewConversation}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-input/30 px-2.5 py-2 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-primary/10"
        >
          <MessageSquarePlus size={13} /> New conversation
        </button>
      </div>

      <div className="shrink-0 px-3 pb-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-input/30 px-2 py-1.5">
          <Search size={12} className="shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {results.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            {query.trim() ? "No conversations match." : "No conversations yet."}
          </p>
        ) : (
          <div className="space-y-3">
            {recent.length > 0 && (
              <div>
                <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Recent</p>
                <div className="space-y-0.5">
                  {recent.map((c) => (
                    <ConversationRow
                      key={c.conversationId} conversation={c} isActive={c.conversationId === activeConversationId}
                      onOpen={() => onOpenConversation(c.conversationId)}
                      onRename={(title) => onRenameConversation(c.conversationId, title)}
                      onDelete={() => onDeleteConversation(c.conversationId)}
                    />
                  ))}
                </div>
              </div>
            )}
            {older.length > 0 && (
              <div>
                <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Older</p>
                <div className="space-y-0.5">
                  {older.map((c) => (
                    <ConversationRow
                      key={c.conversationId} conversation={c} isActive={c.conversationId === activeConversationId}
                      onOpen={() => onOpenConversation(c.conversationId)}
                      onRename={(title) => onRenameConversation(c.conversationId, title)}
                      onDelete={() => onDeleteConversation(c.conversationId)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {conversations.length > 0 && (
        <div className="shrink-0 border-t border-border/70 px-3 py-2">
          {confirmingClear ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => { onClearHistory(); setConfirmingClear(false); }}
                className="flex-1 rounded-lg bg-danger px-2 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90"
              >
                Confirm clear all
              </button>
              <button
                onClick={() => setConfirmingClear(false)}
                className="rounded-lg border border-border px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingClear(true)}
              className="w-full rounded-lg px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:bg-danger/10 hover:text-danger"
            >
              Clear history
            </button>
          )}
        </div>
      )}
    </div>
  );
}
