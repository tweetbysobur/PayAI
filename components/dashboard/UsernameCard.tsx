"use client";

import { useEffect, useState } from "react";
import { AtSign, Check, Loader2, Pencil, X } from "lucide-react";
import { Card } from "@/components/ui";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { useUsername } from "@/lib/hooks/useUsername";
import { normalizeUsername, renameMessage, validateUsername } from "@/lib/platform/username";
import { useToast } from "@/components/Toast";

/**
 * Your PayAI username — the readable identity that stands in for a 42-character
 * address across the product.
 *
 * Usernames are chosen, never assigned — until someone picks one, PayAI shows
 * their short address. Claiming requires a wallet signature (the server has no
 * other way to know the request came from the owner) and is first come, first
 * served: a name in use is unavailable to everyone else, which is the whole
 * point of a name in a payments product.
 */
export function UsernameCard() {
  const wallet = useWalletService();
  const { username, hasUsername, display, refresh } = useUsername(wallet.address);
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live "is this free?" feedback, so nobody types a name, signs for it, and
  // only then learns it was taken.
  const [taken, setTaken] = useState<{ available: boolean; reason?: string } | null>(null);

  // Debounced availability probe while typing.
  useEffect(() => {
    if (!editing) return;
    const next = normalizeUsername(draft);
    if (!validateUsername(next).ok) { setTaken(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/username?available=${encodeURIComponent(next)}&address=${wallet.address ?? ""}`)
        .then((r) => r.json())
        .then((j) => { if (!cancelled) setTaken({ available: !!j.available, reason: j.reason }); })
        .catch(() => {});
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [draft, editing, wallet.address]);

  if (!wallet.address) return null;

  function startEditing() {
    setDraft(username ?? "");
    setTaken(null);
    setError(null);
    setEditing(true);
  }

  async function save() {
    const next = normalizeUsername(draft);
    const check = validateUsername(next);
    if (!check.ok) { setError(check.error ?? "That username isn't valid."); return; }

    setBusy(true);
    setError(null);
    try {
      // Proves ownership, and costs an approval either way: a PayAI Wallet
      // asks for the passkey, an external wallet shows its own prompt. A name
      // is how other people will find and pay you, so it should.
      const signature = await wallet.signMessage(renameMessage(wallet.address!, next));
      const r = await fetch("/api/username", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: wallet.address, username: next, signature }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save that username.");
      refresh();
      setEditing(false);
      toast(`Username set to @${next}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that username.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Your PayAI username" className="mb-4">
      {!editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><AtSign size={18} /></div>
            <div>
              <p className="font-mono text-sm text-foreground">{display || "—"}</p>
              <p className="text-xs text-muted-foreground">
                {hasUsername
                  ? "Your username. Yours alone — no one else can claim it."
                  : "You haven't chosen a username yet. Pick one so people can pay you by name."}
              </p>
            </div>
          </div>
          <button
            onClick={startEditing}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-input/40"
          >
            <Pencil size={12} /> {hasUsername ? "Edit" : "Choose"}
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-input/40 px-3 py-2.5">
            <span className="text-sm text-muted-foreground">@</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) void save(); }}
              placeholder="your-name" autoFocus maxLength={20}
              className="w-full bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            3–20 characters. Lowercase letters, numbers, hyphens and underscores.
          </p>
          {taken && (
            <p className={`mt-1.5 flex items-center gap-1.5 text-[11px] ${taken.available ? "text-success" : "text-danger"}`}>
              {taken.available ? <><Check size={11} /> @{normalizeUsername(draft)} is available</> : taken.reason}
            </p>
          )}
          {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setEditing(false)} disabled={busy}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            >
              <X size={12} /> Cancel
            </button>
            <button
              onClick={save} disabled={busy || !draft.trim() || taken?.available === false}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
