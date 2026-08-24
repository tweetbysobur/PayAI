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
 */
import { createContext, useContext } from "react";
import { useAskChat } from "./useAskChat";

type AskChat = ReturnType<typeof useAskChat>;

const AskPageChatContext = createContext<AskChat | null>(null);

export function AskPageChatProvider({ children }: { children: React.ReactNode }) {
  const chat = useAskChat();
  return <AskPageChatContext.Provider value={chat}>{children}</AskPageChatContext.Provider>;
}

/** Throws outside the provider — a missing provider is an app-wiring bug,
 *  not a state a caller should silently fall back from. */
export function useAskPageChat(): AskChat {
  const ctx = useContext(AskPageChatContext);
  if (!ctx) throw new Error("useAskPageChat must be used within an AskPageChatProvider");
  return ctx;
}
