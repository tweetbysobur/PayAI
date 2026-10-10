/**
 * Dashboard → Ask PayAI hand-off: the rules, as a pure function.
 *
 * The Dashboard's intent box never executes, approves or plans anything. It
 * hands the person's exact words to the existing Ask PayAI conversation
 * (AskPageChatContext), which takes it from there through the normal
 * intent → plan → review → approval → wallet path.
 *
 * Two safety rules decide how:
 *
 *   1. The intent always starts a FRESH conversation. Ask's send() treats a
 *      bare "yes"/"confirm" as approving the conversation's ready card; in an
 *      empty conversation there is no card, so nothing can be approved by a
 *      hand-off. The hand-off waits until the conversation is actually empty
 *      and idle before sending.
 *   2. A message that is ONLY an affirmation ("yes", "do it", "confirm") is
 *      never sent from a hand-off at all — it is placed in the composer for
 *      the person to see. A word of agreement typed on another page is not
 *      an intent.
 */
import { AFFIRMATION_RE } from "./useAskChat";

/** Ask's own ceiling for a single request (the multi-action plan limit). */
export const HANDOFF_MAX_CHARS = 40_000;

export type HandoffStep =
  | { kind: "wait" }                    // a turn is still running — try again when it ends
  | { kind: "reset" }                   // clear to a fresh conversation first
  | { kind: "send"; text: string }      // submit as the conversation's first message
  | { kind: "prefill"; text: string }   // place in the composer only, never send
  | { kind: "drop" };                   // nothing usable to hand off

export function handoffStep(text: string, chat: { messageCount: number; thinking: boolean }): HandoffStep {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > HANDOFF_MAX_CHARS) return { kind: "drop" };
  if (chat.thinking) return { kind: "wait" };
  if (chat.messageCount > 0) return { kind: "reset" };
  if (AFFIRMATION_RE.test(trimmed)) return { kind: "prefill", text: trimmed };
  return { kind: "send", text: trimmed };
}
