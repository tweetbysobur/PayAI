"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { History } from "lucide-react";
import { AskMark, AskLogo } from "@/components/AskMark";
import { AskEmptyState, CAPABILITY_SHORTCUTS } from "@/components/ask/AskEmptyState";
import { ChatMessageRow, ThinkingRow } from "@/components/ask/ChatMessage";
import { ChatComposer } from "@/components/ask/ChatComposer";
import { ConversationList } from "@/components/ask/ConversationList";
import { retryTextFor } from "@/lib/ask/useAskChat";
import { useAskPageChat } from "@/lib/ask/AskPageChatContext";
import { AutomationCreator } from "@/components/dashboard/AutomationCreator";

/** send_payment, swap, schedule/recurring handoff, balance, history, and
 *  automation listing all run through the real PayAI pipeline now — see
 *  lib/ask/intent/. Flip this back to `true` to hide the page again behind
 *  a "coming soon" placeholder without removing any code. */
const COMING_SOON = false;

function AskComingSoon() {
  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col">
      <div className="mb-3 flex shrink-0 items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
          <AskMark size={16} />
        </span>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Ask PayAI</h1>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-2xl border border-border bg-panel/40 px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
          className="text-primary"
        >
          <AskLogo size={56} />
        </motion.div>
        <motion.h2
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.35 }}
          className="mt-4 text-2xl font-semibold tracking-tight text-foreground"
        >
          Coming soon
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.35 }}
          className="mt-2 max-w-md text-center text-sm leading-relaxed text-muted-foreground"
        >
          We&apos;re building natural-language payments — tell PayAI what you want in your own words, and it
          prepares it for your review, with nothing moving until you confirm and sign. Check back soon.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.35 }}
          className="mt-8 flex flex-wrap items-center justify-center gap-2"
        >
          {CAPABILITY_SHORTCUTS.map((s, i) => {
            const Icon = s.icon;
            return (
              <motion.div
                key={s.label}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.18 + i * 0.04, duration: 0.3 }}
                className="flex items-center gap-1.5 rounded-full border border-border bg-panel px-3.5 py-1.5 text-xs font-medium text-muted-foreground opacity-60"
              >
                <Icon size={13} />
                {s.label}
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </div>
  );
}

function AskPayAIChat() {
  const {
    wallet, messages, input, setInput, thinking, thinkingLabel, thinkingHint, thinkingStartedAt, progress,
    send, sendVisual, retryThinking, editRequest, advanceOperation, retryOperation, cancelOperation, newConversation,
    automationDraft, closeAutomationDraft, completeAutomationDraft,
    // P1.3 — conversation history. The rail below is purely a view over
    // these; every action just calls straight through to the hook, which
    // owns the actual wallet-scoped storage and safety rules.
    conversations, activeConversationId, openConversation,
    renameConversationAction, deleteConversationAction, clearHistoryAction, searchConversationsAction,
  } = useAskPageChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Collapsed by default so a first-time visitor sees the conversation, not
  // a rail with nothing in it — matches "the conversation remains the
  // dominant UI element". On desktop this toggles a persistent side column;
  // on a phone (no room for both side by side) it toggles a slide-over
  // drawer instead — same state, different presentation below.
  const [historyOpen, setHistoryOpen] = useState(false);

  // "?new=1" (the welcome tour's last step) opens a new conversation instead
  // of the last saved one, then drops the flag so a refresh keeps the chat.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("new") !== "1") return;
    newConversation();
    url.searchParams.delete("new");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Follow the conversation; with none yet, keep the welcome screen's top in view.
    const el = scrollRef.current;
    if (!el) return;
    if (messages.length === 0 && !thinking) el.scrollTo({ top: 0 });
    else el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  return (
    <div className="mx-auto flex h-full max-w-6xl gap-3">
      {/* Desktop: a persistent, collapsible rail alongside the chat — never
          a new top-level dashboard nav item, just a panel within this page. */}
      <div
        className={`hidden shrink-0 overflow-hidden rounded-2xl border bg-panel/40 transition-[width] duration-200 sm:block ${
          historyOpen ? "w-64 border-border" : "w-0 border-transparent"
        }`}
      >
        {historyOpen && (
          <ConversationList
            conversations={conversations}
            activeConversationId={activeConversationId}
            onNewConversation={newConversation}
            onOpenConversation={openConversation}
            onRenameConversation={renameConversationAction}
            onDeleteConversation={deleteConversationAction}
            onClearHistory={clearHistoryAction}
            onSearch={searchConversationsAction}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
              <AskMark size={16} />
            </span>
            <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">Ask PayAI</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              aria-label={historyOpen ? "Hide conversation history" : "Show conversation history"}
              aria-pressed={historyOpen}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                historyOpen ? "border-primary/40 bg-primary/10 text-primary-ink" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
              }`}
            >
              <History size={13} /> <span className="hidden sm:inline">History</span>
            </button>
            {messages.length > 0 && (
              <button
                onClick={newConversation}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="sm:hidden">New</span>
                <span className="hidden sm:inline">New conversation</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-panel/40">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {messages.length === 0 ? (
              <AskEmptyState />
            ) : (
              <div role="log" aria-live="polite" aria-label="Conversation with Ask PayAI" className="space-y-4 p-4 sm:p-6">
                {messages.map((m) => (
                  <ChatMessageRow
                    key={m.id}
                    message={m}
                    walletAddress={wallet.address}
                    onAdvanceOperation={advanceOperation}
                    onCancelOperation={cancelOperation}
                    onQuickAction={send}
                    // Only offer "Try again" where retrying actually does
                    // something — a schedule/recurring handoff card (or any
                    // future kind without a canonical retry text) would
                    // otherwise show a button that silently does nothing.
                    onRetryOperation={m.operation && retryTextFor(m.operation) ? retryOperation : undefined}
                    progressLabel={m.operation ? progress[m.operation.id] : undefined}
                    onEditPlan={editRequest}
                  />
                ))}
                {thinking && <ThinkingRow label={thinkingLabel} hint={thinkingHint} startedAt={thinkingStartedAt} onRetry={retryThinking} />}
              </div>
            )}
          </div>

          <ChatComposer value={input} onChange={setInput} onSend={() => send(input)} onSendImage={wallet.address ? sendVisual : undefined} disabled={thinking} />
        </div>
      </div>

      {/* Mobile: the rail becomes a slide-over drawer instead of a
          persistent column — there's no room for both side by side on a
          phone. Same underlying state (historyOpen) and the same
          ConversationList component as desktop, just presented differently. */}
      <AnimatePresence>
        {historyOpen && (
          <motion.div
            key="history-overlay"
            className="fixed inset-0 z-40 flex sm:hidden"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          >
            <button
              aria-label="Close conversation history"
              onClick={() => setHistoryOpen(false)}
              className="absolute inset-0 bg-contrast/40"
            />
            <motion.div
              initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }} transition={{ duration: 0.2, ease: "easeOut" }}
              className="relative flex h-full w-[82vw] max-w-xs flex-col border-r border-border bg-panel shadow-2xl"
            >
              <ConversationList
                conversations={conversations}
                activeConversationId={activeConversationId}
                onNewConversation={() => { newConversation(); setHistoryOpen(false); }}
                onOpenConversation={(id) => { openConversation(id); setHistoryOpen(false); }}
                onRenameConversation={renameConversationAction}
                onDeleteConversation={deleteConversationAction}
                onClearHistory={clearHistoryAction}
                onSearch={searchConversationsAction}
                onClose={() => setHistoryOpen(false)}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A scheduled/recurring intent opens the real AutomationCreator right
          here, seeded with the resolved prefill, instead of navigating away.
          Creation runs the exact same wizard the /dashboard/automations page
          uses — same signature, approval/reserve, and signed POST — and on
          success turns the handoff card into an in-chat success state. */}
      <AutomationCreator
        open={!!automationDraft}
        seed={automationDraft?.seed ?? null}
        onClose={closeAutomationDraft}
        onCreated={(created) => { if (created) completeAutomationDraft(created); }}
      />
    </div>
  );
}

export default function AskPayAIPage() {
  return COMING_SOON ? <AskComingSoon /> : <AskPayAIChat />;
}
