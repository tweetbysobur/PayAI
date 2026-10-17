"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { useAskHandoff } from "@/lib/ask/AskPageChatContext";
import { HANDOFF_MAX_CHARS } from "@/lib/ask/handoff";

/**
 * The intent box — a way INTO Ask PayAI, never a second Ask.
 *
 * Submitting hands the person's exact words to the existing Ask PayAI
 * conversation (useAskHandoff → AskPageChatContext) and opens Ask, where the
 * request is the first message of a fresh conversation and goes through the
 * normal intent → plan → review → approval → wallet path. This component
 * plans, approves, signs and sends nothing itself. See lib/ask/handoff.ts for
 * why a hand-off always starts a fresh conversation and why a bare "yes" is
 * never submitted from here.
 *
 * Suggestions only start the sentence ("Send ") and focus the box — they
 * never submit, and never put an invented transaction in the person's mouth.
 */
export function AskEntry({ label, placeholder = "What do you want to do?", suggestions = [], id = "ask-entry", hideLabel = false }: {
  label: string;
  placeholder?: string;
  suggestions?: readonly { label: string; fill: string }[];
  id?: string;
  hideLabel?: boolean;
}) {
  const router = useRouter();
  const startIntent = useAskHandoff();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function submit() {
    const intent = text.trim();
    if (!intent) { ref.current?.focus(); return; }
    startIntent(intent);
    router.push("/dashboard/ask");
  }

  function onSubmit(e: FormEvent) { e.preventDefault(); submit(); }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  }

  function suggest(fill: string) {
    const el = ref.current;
    const next = text.trim() ? text : fill;
    setText(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
      grow(el);
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-2 block text-sm font-medium text-foreground"}>{label}</label>
      <div className="flex items-end gap-2 rounded-xl border border-border bg-panel p-2 transition-colors focus-within:border-primary/60">
        <textarea
          ref={ref}
          id={id}
          rows={1}
          value={text}
          onChange={(e) => { setText(e.target.value); grow(e.target); }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          maxLength={HANDOFF_MAX_CHARS}
          className="max-h-[200px] min-h-11 min-w-0 flex-1 resize-none [field-sizing:content] bg-transparent px-2.5 py-2.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <button
          type="submit"
          aria-label="Continue in Ask PayAI"
          disabled={!text.trim()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-input disabled:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowUp size={18} aria-hidden />
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => suggest(s.fill)}
              className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
