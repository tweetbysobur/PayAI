"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, ImagePlus, Loader2, X } from "lucide-react";
import { prepareImage } from "@/lib/ask/visual/prepareImage";

const MAX_ROWS = 8;

export function ChatComposer({
  value,
  onChange,
  onSend,
  onSendImage,
  disabled,
  // Mirrors the empty state's on-ramps, in the same words — "automate" rather
  // than "schedule", and trading named since it is a headline capability.
  placeholder = "Describe what you want done…",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** Visual intent input. When given, an image (or QR code) can be attached;
   *  the text box becomes its optional caption. Resolves true once sent. */
  onSendImage?: (image: Blob, caption: string) => Promise<boolean>;
  disabled?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<{ blob: Blob; url: string; name: string } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

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

  // The preview is a local object URL — never uploaded anywhere as a link.
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setImageError(null);
    setPreparing(true);
    try {
      const prepared = await prepareImage(file);
      if (!prepared.ok) { setImageError(prepared.message); return; }
      setImage({ blob: prepared.blob, url: URL.createObjectURL(prepared.blob), name: file.name || "Image" });
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const busy = disabled || preparing || sending;
  const canSend = !busy && (image ? true : !!value.trim());

  async function submit() {
    if (!canSend) return;
    if (image && onSendImage) {
      setSending(true);
      try {
        if (await onSendImage(image.blob, value)) setImage(null);
      } finally {
        setSending(false);
      }
      return;
    }
    onSend();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-panel px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:px-5">
      {(image || preparing || imageError) && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-3">
          {image && (
            <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-input/40 p-1.5 pr-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, not a remote image */}
              <img src={image.url} alt="Attached image preview" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">{image.name}</p>
                <p className="text-[11px] text-muted-foreground">{sending ? "Reading…" : "Add a caption, or send as is"}</p>
              </div>
              <button
                type="button"
                onClick={() => setImage(null)}
                disabled={sending}
                aria-label="Remove image"
                className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-input hover:text-foreground disabled:opacity-40"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {preparing && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" /> Preparing image…</p>}
          {imageError && !preparing && <p role="alert" className="text-xs text-destructive">{imageError}</p>}
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border bg-input/40 px-3 py-2 transition-colors focus-within:border-primary/40">
        {onSendImage && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
              className="hidden"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy || !!image}
              aria-label="Attach an image or QR code"
              title="Attach an image or QR code"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-input hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ImagePlus size={17} />
            </button>
          </>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={image ? "Add a caption (optional) — e.g. “Send 5 USDC to this address”" : placeholder}
          disabled={disabled || sending}
          aria-label={image ? "Caption for the attached image" : "Message Ask PayAI"}
          className="max-h-40 w-full resize-none bg-transparent py-1.5 text-base leading-5 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60 sm:text-sm"
        />
        <button
          onClick={() => void submit()}
          disabled={!canSend}
          aria-label={image ? "Send image" : "Send message"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={15} />}
        </button>
      </div>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted-foreground">
        Ask PayAI prepares payments for your review — nothing moves until you confirm and sign.
      </p>
    </div>
  );
}
