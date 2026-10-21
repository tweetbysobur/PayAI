"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { primePlan, type PlanCardData } from "@/lib/ask/planCards";
import { createEscrowRoom, previewEscrowRoom, type EscrowRoomForm, type EscrowRoomPreview } from "@/lib/rooms/client";
import { shortAddr } from "@/components/rooms/format";
import { roomMinimumText } from "@/lib/rooms/escrowChain";

const INPUT = "h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const LABEL = "mb-1.5 block text-xs font-medium text-muted-foreground";

/**
 * Create an escrow Room: fill the terms, preview EVERY term (computed by the
 * server, including the escrow's live fee), then create — which returns the
 * creator's create_room plan to review and sign on the room's page. Nothing
 * is stored on-chain, and no funds move, until that's signed.
 */
export function EscrowCreateForm({ disabledReason, symbols }: { disabledReason: string | null; symbols: string[] }) {
  const router = useRouter();
  const [form, setForm] = useState<EscrowRoomForm>({
    kind: "target", token: symbols[0] ?? "USDC", amount: "", participants: 5, minContribution: "", durationDays: 14,
    beneficiary: "", title: "", description: "", publicListing: false,
  });
  const [preview, setPreview] = useState<EscrowRoomPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof EscrowRoomForm>(k: K, v: EscrowRoomForm[K]) => { setForm((f) => ({ ...f, [k]: v })); setPreview(null); };
  const disabled = disabledReason !== null;
  const platformMin = roomMinimumText(form.token);

  async function onPreview(e: React.FormEvent) {
    e.preventDefault();
    if (busy || disabled) return;
    setBusy("preview"); setError(null);
    const r = await previewEscrowRoom(form);
    setBusy(null);
    if (r.ok) setPreview(r.data); else setError(r.status === 401 ? "Unlock your wallet to create a room." : r.message);
  }

  async function onCreate() {
    if (busy) return;
    setBusy("create"); setError(null);
    const r = await createEscrowRoom(form);
    setBusy(null);
    if (!r.ok) { setError(r.message); return; }
    primePlan({ plan: r.data.plan, review: r.data.review } as PlanCardData);
    router.push(`/dashboard/rooms/${r.data.id}`);
  }

  return (
    <section aria-labelledby="escrow-new" className="rounded-lg border border-border bg-panel">
      <div className="border-b border-border px-5 py-3.5">
        <h2 id="escrow-new" className="flex items-center gap-2 text-sm font-semibold text-foreground"><ShieldCheck size={15} className="text-primary-ink" aria-hidden />New escrow room</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Contributions are held by the Room escrow contract until the room completes — or refunded if it doesn&apos;t.</p>
      </div>
      {disabled && <p role="status" className="border-b border-border bg-warning/[0.05] px-5 py-3 text-pretty text-sm text-foreground">{disabledReason}</p>}
      <form onSubmit={onPreview} className="space-y-4 px-5 py-4" aria-disabled={disabled}>
        <fieldset disabled={disabled} className="space-y-4">
          <div role="radiogroup" aria-label="Room type" className="grid grid-cols-2 gap-2">
            {([["target", "Fundraising target", "Anyone contributes toward a goal"], ["fixed", "Fixed shares", "N people each pay the same"]] as const).map(([k, t, d]) => (
              <button key={k} type="button" role="radio" aria-checked={form.kind === k} onClick={() => set("kind", k)}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${form.kind === k ? "border-primary/60 bg-primary/[0.06]" : "border-border hover:border-primary/30"}`}>
                <span className="block text-sm font-medium text-foreground">{t}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{d}</span>
              </button>
            ))}
          </div>
          <label className="block"><span className={LABEL}>Title</span>
            <input value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={80} placeholder="Community garden fund" className={INPUT} /></label>
          <label className="block"><span className={LABEL}>Description <span className="font-normal">(optional)</span></span>
            <textarea value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={500} rows={3} placeholder="What the money is for"
              className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className="block"><span className={LABEL}>{form.kind === "fixed" ? "Each person pays" : "Target"}</span>
              <input inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder={form.kind === "fixed" ? "20" : "1000"} className={INPUT} /></label>
            <label className="block"><span className={LABEL}>Token</span>
              <select value={form.token} onChange={(e) => set("token", e.target.value)} className={`${INPUT} pr-8`}>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select></label>
          </div>
          {platformMin && (
            <p className="-mt-2 text-xs text-muted-foreground">
              {form.kind === "fixed"
                ? `Each share must be at least ${platformMin} — PayAI Rooms' minimum contribution.`
                : `Contributions must be at least ${platformMin} (PayAI Rooms' minimum), except the final amount that completes the room. The target must be at least ${platformMin}.`}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {form.kind === "fixed" ? (
              <label className="block"><span className={LABEL}>People paying</span>
                <input inputMode="numeric" value={String(form.participants ?? "")} onChange={(e) => set("participants", Number(e.target.value.replace(/\D/g, "")) || 0)} className={INPUT} /></label>
            ) : (
              <label className="block"><span className={LABEL}>Minimum contribution <span className="font-normal">(optional)</span></span>
                <input inputMode="decimal" value={form.minContribution ?? ""} onChange={(e) => set("minContribution", e.target.value)} placeholder={platformMin ? `${platformMin.split(" ")[0]} (platform minimum)` : "Platform minimum"} className={INPUT} /></label>
            )}
            <label className="block"><span className={LABEL}>Open for (days)</span>
              <input inputMode="numeric" value={String(form.durationDays || "")} onChange={(e) => set("durationDays", Number(e.target.value.replace(/\D/g, "")) || 0)} className={INPUT} /></label>
          </div>
          <label className="block"><span className={LABEL}>Funds go to <span className="font-normal">(optional — you, if empty)</span></span>
            <input value={form.beneficiary ?? ""} onChange={(e) => set("beneficiary", e.target.value)} placeholder="0x… or name.nad" className={INPUT} /></label>
          <label className="flex items-start gap-2.5 text-sm text-foreground">
            <input type="checkbox" checked={form.publicListing} onChange={(e) => set("publicListing", e.target.checked)} className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" />
            <span>List it in Live Rooms<span className="block text-xs text-muted-foreground">Anyone can find it. Leave off to share by link only.</span></span>
          </label>
        </fieldset>
        {!preview && (
          <button type="submit" disabled={busy != null || disabled || !form.amount.trim() || form.title.trim().length < 3}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 sm:w-auto">
            {busy === "preview" && <Loader2 size={14} className="animate-spin" aria-hidden />} Preview terms
          </button>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </form>

      {preview && (
        <div className="border-t border-border px-5 py-4">
          <p className="text-sm font-medium text-foreground">{preview.title}</p>
          <dl className="mt-3 grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{preview.kind === "fixed" ? "Total" : "Target"}</dt><dd className="tabular-nums text-foreground">{preview.target} {preview.asset.symbol}</dd>
            {preview.kind === "fixed" && <><dt className="text-muted-foreground">Each pays</dt><dd className="tabular-nums text-foreground">{preview.share} {preview.asset.symbol} × {preview.participants}</dd></>}
            {preview.minContribution && <><dt className="text-muted-foreground">Minimum</dt><dd className="tabular-nums text-foreground">{preview.minContribution} {preview.asset.symbol}</dd></>}
            <dt className="text-muted-foreground">Open for</dt><dd className="text-foreground">{preview.durationDays} day{preview.durationDays === 1 ? "" : "s"} after creation</dd>
            <dt className="text-muted-foreground">Funds go to</dt><dd className="break-all text-foreground">{preview.beneficiary.isCreator ? "You" : preview.beneficiary.label ?? shortAddr(preview.beneficiary.address)}</dd>
            <dt className="text-muted-foreground">PayAI fee</dt><dd className="text-foreground">{preview.fee.percent} of the payout, only if it completes ({preview.fee.onSuccess} if fully funded)</dd>
            <dt className="text-muted-foreground">Listed publicly</dt><dd className="text-foreground">{preview.publicListing ? "Yes, in Live Rooms" : "No — link only"}</dd>
          </dl>
          <ul className="mt-4 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
            {preview.conditions.map((c) => <li key={c} className="flex gap-2 [overflow-wrap:anywhere]"><span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />{c}</li>)}
          </ul>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:flex">
            <button type="button" onClick={onCreate} disabled={busy != null}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
              {busy === "create" && <Loader2 size={14} className="animate-spin" aria-hidden />} Create room
            </button>
            <button type="button" onClick={() => setPreview(null)} disabled={busy != null}
              className="inline-flex h-11 items-center justify-center rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-input">Edit</button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Next you&apos;ll review and sign one transaction that creates the room on-chain. It moves no funds.</p>
        </div>
      )}
    </section>
  );
}
