"use client";

import { useEffect, useState } from "react";
import { AtSign, Check, Loader2, X } from "lucide-react";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { normalizeUsername, renameMessage, validateUsername } from "@/lib/platform/username";

/**
 * Offers a username during onboarding — the natural moment to pick one, right
 * after the wallet exists.
 *
 * Deliberately optional and inline rather than a required step: a name is
 * useful, but blocking someone from reaching their new wallet until they
 * invent one is the kind of friction this whole sprint is removing. Anyone
 * who skips it keeps their short address and can choose later in Settings.
 *
 * Availability is checked as you type, so nobody picks a name, signs for it,
 * and only then discovers it was taken.
 */
export function ChooseUsername({ address }: { address: string }) {
  const wallet = useWalletService();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<{ available: boolean; reason?: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeUsername(draft);
  const shape = validateUsername(normalized);

  useEffect(() => {
    if (!draft) { setStatus(null); return; }
    if (!shape.ok) { setStatus({ available: false, reason: shape.error }); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/username?available=${encodeURIComponent(normalized)}&address=${address}`)
        .then((r) => r.json())
        .then((j) => { if (!cancelled) setStatus({ available: !!j.available, reason: j.reason }); })
        .catch(() => {});
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, address]);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const signature = await wallet.signMessage(renameMessage(address, normalized));
      const r = await fetch("/api/username", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, username: normalized, signature }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not claim that username.");
      setSaved(j.username);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not claim that username.");
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/[0.07] px-3.5 py-2.5">
        <Check size={14} className="shrink-0 text-success" />
        <p className="text-xs text-foreground">
          You&apos;re <span className="font-mono font-medium">@{saved}</span> on PayAI.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-input/20 px-3.5 py-3">
      <p className="text-xs font-medium text-foreground">Pick a username <span className="font-normal text-muted-foreground">(optional)</span></p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">So people can pay you by name instead of an address.</p>

      <div className="mt-2.5 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1.5 rounded-lg border border-border bg-panel px-2.5 py-2">
          <AtSign size={13} className="shrink-0 text-muted-foreground" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && status?.available && !busy) void claim(); }}
            placeholder="yourname" maxLength={20}
            className="w-full bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <button
          onClick={claim}
          disabled={!status?.available || busy}
          className="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : "Claim"}
        </button>
      </div>

      {status && draft && (
        <p className={`mt-1.5 flex items-center gap-1.5 text-[11px] ${status.available ? "text-success" : "text-danger"}`}>
          {status.available ? <><Check size={11} /> @{normalized} is available</> : <><X size={11} /> {status.reason}</>}
        </p>
      )}
      {error && <p className="mt-1.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}
