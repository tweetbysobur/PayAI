"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence, useMotionValue } from "motion/react";
import { Sparkles, X } from "lucide-react";
import { AskEmptyState } from "@/components/ask/AskEmptyState";
import { ChatMessageRow, ThinkingRow } from "@/components/ask/ChatMessage";
import { ChatComposer } from "@/components/ask/ChatComposer";
import { useAskChat, retryTextFor } from "@/lib/ask/useAskChat";

/** Screen edges the button can never be dragged past, so it can't be dropped
 *  under the sidebar/topbar or off-screen where it becomes unreachable. */
const EDGE_MARGIN = 16;
const POS_KEY = "payai_ask_button_pos";

/** Fits a saved/measured position back inside the current viewport — the
 *  window may have resized or rotated since the position was saved. */
function clamp(pos: { x: number; y: number }, w: number, h: number) {
  return {
    x: Math.min(Math.max(pos.x, EDGE_MARGIN), window.innerWidth - w - EDGE_MARGIN),
    y: Math.min(Math.max(pos.y, EDGE_MARGIN), window.innerHeight - h - EDGE_MARGIN),
  };
}

/**
 * AI Command Bar — Cmd+K (or the floating button) opens a focused overlay that
 * runs ONE command through the real agent pipeline and shows the result inline.
 * The AI surface lives on top of the dashboard, not as a separate chat page.
 */
export function CommandBar() {
  const [open, setOpen] = useState(false);
  // The exact same conversation engine as the full-page Ask PayAI workspace
  // (app/dashboard/ask) — called here at the top level, not inside the
  // popup's conditional JSX, so the conversation survives closing and
  // reopening the popup instead of resetting each time.
  const chat = useAskChat();
  // The dedicated Ask PayAI workspace (app/dashboard/ask) IS this feature,
  // full-page — floating a second, smaller "Ask PayAI" trigger on top of it
  // (and letting ⌘K pop the compact modal over the page already showing the
  // same thing) is redundant at best and visually collides with the page's
  // own content at worst. Suppressed only on that one route; every other
  // page keeps the trigger exactly as it was.
  const pathname = usePathname();
  const onAskPage = pathname === "/dashboard/ask";
  const scrollRef = useRef<HTMLDivElement>(null);

  // Draggable trigger — it used to sit permanently in the bottom-right
  // corner, which on a shorter page (or a phone) sat directly on top of
  // whatever content ended up there. x/y are absolute screen coordinates for
  // a top:0/left:0 element, so dragging it just means moving these.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [positioned, setPositioned] = useState(false);
  // Only ever set inside effects, so it stays null through the server
  // render — `dragConstraints` reads `window` through this, never directly
  // in the render body, which is what keeps this component SSR-safe.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Set on drag start/move, read (and reset) in onClick so a drag that
  // actually moved the button doesn't also open it — the two gestures start
  // identically (a pointer going down on the button) and only diverge once
  // movement happens.
  const draggedRef = useRef(false);

  useEffect(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const { width, height } = btn.getBoundingClientRect();
    setSize({ w: width, h: height });
    // Its ORIGINAL resting spot — bottom-6 right-6, i.e. 24px from each edge —
    // is the fallback so nothing jumps on first paint for someone who has
    // never dragged it.
    const fallback = { x: window.innerWidth - width - 24, y: window.innerHeight - height - 24 };
    let pos = fallback;
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) pos = clamp(JSON.parse(saved), width, height);
    } catch {
      /* corrupt/blocked storage — use the default corner */
    }
    x.set(pos.x);
    y.set(pos.y);
    setPositioned(true);

    // A resize (rotating a phone, un-maximizing a window) can leave a saved
    // position outside the new viewport entirely.
    function onResize() {
      if (!btn) return;
      const { width: w, height: h } = btn.getBoundingClientRect();
      setSize({ w, h });
      const next = clamp({ x: x.get(), y: y.get() }, w, h);
      x.set(next.x);
      y.set(next.y);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inert {0,0,0,0} until `size` is measured client-side — that keeps this
  // expression free of `window` during the server render, and a drag can't
  // happen before the button has painted with a real position anyway.
  const dragConstraints = size
    ? {
        left: EDGE_MARGIN, top: EDGE_MARGIN,
        right: Math.max(EDGE_MARGIN, window.innerWidth - size.w - EDGE_MARGIN),
        bottom: Math.max(EDGE_MARGIN, window.innerHeight - size.h - EDGE_MARGIN),
      }
    : { left: 0, top: 0, right: 0, bottom: 0 };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (onAskPage) return;
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAskPage]);

  // Closing the popup keeps the conversation intact (chat state lives above,
  // outside this conditional render) — reopening just scrolls back to the
  // latest message, the same as a real chat window being un-minimized.
  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [open, chat.messages, chat.thinking]);

  return (
    <>
      {!onAskPage && (
      <motion.button
        ref={triggerRef}
        drag
        dragMomentum={false}
        dragElastic={0}
        dragConstraints={dragConstraints}
        whileDrag={{ scale: 1.06 }}
        onDragStart={() => { draggedRef.current = true; }}
        onDragEnd={() => {
          try { localStorage.setItem(POS_KEY, JSON.stringify({ x: x.get(), y: y.get() })); } catch { /* private browsing */ }
          // The pointerup that ends a drag also fires a click in some
          // browsers; clear the flag just after so a REAL next tap still
          // opens the bar. requestAnimationFrame is one frame — long enough
          // to outlast that synthetic click, short enough nobody notices.
          requestAnimationFrame(() => { draggedRef.current = false; });
        }}
        onClick={() => { if (draggedRef.current) return; setOpen(true); }}
        style={{ x, y, opacity: positioned ? 1 : 0 }}
        className={`fixed left-0 top-0 z-40 flex cursor-grab items-center gap-2 touch-none rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/30 transition-opacity hover:opacity-90 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${positioned ? "" : "pointer-events-none"}`}
        title="Ask PayAI — drag to move"
      >
        <Sparkles size={16} />
        Ask PayAI
        <kbd className="ml-1 hidden rounded border border-primary-foreground/30 px-1.5 py-0.5 text-[10px] opacity-80 sm:inline-block">⌘K</kbd>
      </motion.button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/85 sm:items-start sm:bg-background/70 sm:px-4 sm:pt-[12vh] sm:backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <motion.div
              // A modal overlay with no dialog role is invisible to a screen
              // reader as a modal — it reads as more page content, with no
              // signal that the rest is now inert.
              role="dialog"
              aria-modal="true"
              aria-label="Ask PayAI"
              initial={{ opacity: 0, y: -16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -16, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
              className="flex w-full flex-col overflow-hidden border-border bg-panel shadow-2xl ring-1 ring-primary/5 sm:max-h-[80vh] sm:max-w-xl sm:rounded-2xl sm:border"
            >
              {/* Header — same identity as the full-page Ask PayAI workspace,
                  just compact enough for a popup. */}
              <div className="flex shrink-0 items-center gap-2.5 border-b border-border bg-gradient-to-b from-primary/[0.04] to-transparent px-4 py-3.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
                  <Sparkles size={15} />
                </span>
                <p className="flex-1 text-sm font-semibold text-foreground">Ask PayAI</p>
                {chat.messages.length > 0 && (
                  <button
                    onClick={chat.newConversation}
                    className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    New conversation
                  </button>
                )}
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-input hover:text-foreground"><X size={16} /></button>
              </div>

              {/* The exact same conversation surface as /dashboard/ask — empty
                  state, message history, operation cards, all identical since
                  both render from the same useAskChat() engine. */}
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto sm:max-h-[60vh] sm:flex-none">
                {chat.messages.length === 0 ? (
                  <AskEmptyState onPick={chat.send} />
                ) : (
                  <div role="log" aria-live="polite" aria-label="Conversation with Ask PayAI" className="space-y-4 p-4">
                    {chat.messages.map((m) => (
                      <ChatMessageRow
                        key={m.id}
                        message={m}
                        walletAddress={chat.wallet.address}
                        onAdvanceOperation={chat.advanceOperation}
                        onCancelOperation={chat.cancelOperation}
                        // Only offer "Try again" where retrying actually does
                        // something — a schedule/recurring handoff card (or any
                        // future kind without a canonical retry text) would
                        // otherwise show a button that silently does nothing.
                        onRetryOperation={m.operation && retryTextFor(m.operation) ? chat.retryOperation : undefined}
                      />
                    ))}
                    {chat.thinking && <ThinkingRow />}
                  </div>
                )}
              </div>

              <ChatComposer value={chat.input} onChange={chat.setInput} onSend={() => chat.send(chat.input)} disabled={chat.thinking} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
