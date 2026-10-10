"use client";

/**
 * Keeps the full /dashboard/ask page's conversation alive across in-app
 * navigation. useAskChat() itself is plain in-memory React state — fine for
 * components/dashboard/CommandBar.tsx, which is mounted once in
 * app/dashboard/layout.tsx and never unmounts while the dashboard is open.
 * app/dashboard/ask/page.tsx used to call useAskChat() directly instead, but
 * a PAGE component unmounts on every navigation away and remounts fresh on
 * the way back — so leaving Ask PayAI for any other dashboard page and
 * returning silently wiped the conversation. Calling useAskChat() ONCE here,
 * mounted in the layout (see AskPageChatProvider below), and having the page
 * consume it through context instead fixes that the same way CommandBar's
 * own conversation already survives navigation.
 *
 * Deliberately a SEPARATE conversation from CommandBar's popup — that split
 * is the existing, intentional design (see useAskChat's own doc: two
 * surfaces, same pipeline, not necessarily the same thread), not something
 * this fixes or changes.
 *
 * P1.1: this is also the ONE instance that opts into sessionStorage
 * persistence (`persist: true`) — a browser refresh restores this
 * conversation exactly like in-app navigation already does, instead of
 * silently wiping it. CommandBar's own useAskChat() call stays non-persisted
 * (its default), so the two conversations never read or write the same
 * storage slot. See lib/ask/persistChat.ts for the mechanism.
 */
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useAskChat } from "./useAskChat";
import { handoffStep } from "./handoff";

type AskChat = ReturnType<typeof useAskChat>;

const AskPageChatContext = createContext<AskChat | null>(null);
const AskHandoffContext = createContext<((text: string) => void) | null>(null);

export function AskPageChatProvider({ children }: { children: React.ReactNode }) {
  const chat = useAskChat({ persist: true });

  // Dashboard → Ask hand-off (see lib/ask/handoff.ts for the rules). The
  // pending intent lives in a ref; the effect below advances it one safe
  // step per render — reset to a fresh conversation, wait for it to be empty
  // and idle, then submit through the SAME send() the Ask composer uses.
  // Nothing here plans, approves or executes on its own.
  const pendingRef = useRef<string | null>(null);
  const { messages, thinking, newConversation, send, setInput } = chat;

  useEffect(() => {
    const text = pendingRef.current;
    if (text === null) return;
    const step = handoffStep(text, { messageCount: messages.length, thinking });
    if (step.kind === "wait") return;
    if (step.kind === "reset") { newConversation(); return; }
    pendingRef.current = null;
    if (step.kind === "send") void send(step.text);
    else if (step.kind === "prefill") setInput(step.text);
    // send/newConversation/setInput are re-created every render; the effect
    // is driven by the conversation's state, which is what it waits on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, thinking]);

  const startIntent = useCallback((text: string) => {
    pendingRef.current = text;
    // Always begin from a clean conversation: this re-render is what drives
    // the effect above, even when the conversation is already empty.
    newConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AskPageChatContext.Provider value={chat}>
      <AskHandoffContext.Provider value={startIntent}>{children}</AskHandoffContext.Provider>
    </AskPageChatContext.Provider>
  );
}

/** Hands an intent typed elsewhere (the Dashboard) to Ask PayAI as the first
 *  message of a fresh conversation. The caller navigates to /dashboard/ask. */
export function useAskHandoff(): (text: string) => void {
  const ctx = useContext(AskHandoffContext);
  if (!ctx) throw new Error("useAskHandoff must be used within an AskPageChatProvider");
  return ctx;
}

/** Throws outside the provider — a missing provider is an app-wiring bug,
 *  not a state a caller should silently fall back from. */
export function useAskPageChat(): AskChat {
  const ctx = useContext(AskPageChatContext);
  if (!ctx) throw new Error("useAskPageChat must be used within an AskPageChatProvider");
  return ctx;
}
