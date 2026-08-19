"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Loader2 } from "lucide-react";

const MAX_ROWS = 8;

export function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
  // Mirrors the empty state's on-ramps, in the same words — "automate" rather
  // than "schedule", and trading named since it is a headline capability.
  placeholder = "Send a payment, trade a token, or automate something…",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow with content, capped so a long paste doesn't swallow the page —
  // it scrolls internally past MAX_ROWS instead.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const lineHeight = 20;
    const maxHeight = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSend();
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-panel px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:px-5">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border bg-input/40 px-3 py-2 transition-colors focus-within:border-primary/40">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Message Ask PayAI"
          className="max-h-40 w-full resize-none bg-transparent py-1.5 text-base leading-5 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60 sm:text-sm"
        />
        <button
          onClick={() => value.trim() && onSend()}
          disabled={disabled || !value.trim()}
          aria-label="Send message"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {disabled ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={15} />}
        </button>
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted-foreground/70">
        Ask PayAI prepares payments for your review — nothing moves until you confirm and sign.
      </p>
    </div>
  );
}
