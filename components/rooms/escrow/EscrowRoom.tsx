"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink, Loader2, Lock, Share2, ShieldCheck, Undo2, Wallet } from "lucide-react";
import { StatusIndicator } from "@/components/dashboard/primitives";
import { PlanCard } from "@/components/ask/PlanCard";
import { primePlan, type PlanCardData } from "@/lib/ask/planCards";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import { confirmEscrowAction, getEscrowRoom, startEscrowAction, type EscrowActionKind, type EscrowRoomView } from "@/lib/rooms/client";
import { fmtWhen, shortAddr } from "@/components/rooms/format";
import { ESCROW_STATUS, pct, timeLeft, type EscrowStatusKey } from "./format";
import { feePercent } from "@/lib/rooms/escrowChain";
import { usePlanSettled } from "./usePlanSettled";

type Busy = EscrowActionKind | null;

/**
 * One escrow Room — the shareable payment page (/r/{id}) and, for its
 * creator, the management view. Every number comes from the server's read of
 * the escrow contract; activity lists only transactions the server verified
 * from the escrow's own events. Every money movement is a plan the person
 * reviews, approves and signs in their own wallet (PlanCard); this component
 * never signs or sends.
 */
export function EscrowRoom({ id }: { id: string }) {
  const wallet = useWalletService();
  const [room, setRoom] = useState<EscrowRoomView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [active, setActive] = useState<{ kind: EscrowActionKind; planId: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const r = await getEscrowRoom(id);
    if (r.ok) { setRoom(r.data); setLoadError(null); }
    else setLoadError(r.status === 404 ? "This room doesn't exist. Check the link you were sent." : r.message);
    return r;
  }, [id]);

  useEffect(() => { queueMicrotask(() => void reload()); }, [reload, wallet.address]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  // Keep progress honest while the page is open: re-read the contract.
  useEffect(() => { const t = setInterval(() => void reload(), 20_000); return () => clearInterval(t); }, [reload]);

  // Resume an in-flight plan of the viewer's after a reload.
  useEffect(() => {
    if (active || !room) return;
    const pending = Object.entries(room.viewer.pending)[0] as [EscrowActionKind, string] | undefined;
    if (pending) queueMicrotask(() => setActive({ kind: pending[0], planId: pending[1] }));
  }, [room, active]);

  const settle = useCallback(async () => {
    if (!active) return;
    const r = await confirmEscrowAction(id, active.kind);
    if (r.ok) {
      setRoom(r.data);
      setNotice({ create: "Your room is live on-chain. Share the link.", contribute: "Your contribution is confirmed and held in escrow.", claim: "The room's funds were paid out.", refund: "Your refund is confirmed.", cancel: "The room is cancelled. Contributors can now claim refunds." }[active.kind]);
      setActive(null);
      setAmount("");
    } else if (r.code !== "NOT_SETTLED") {
      setError(r.message);
    }
  }, [active, id]);
  usePlanSettled(active?.planId ?? null, () => void settle());

  async function start(kind: Exclude<EscrowActionKind, "create">) {
    if (busy) return;
    setBusy(kind); setError(null); setNotice(null);
    const r = await startEscrowAction(id, kind, kind === "contribute" && room?.kind === "target" ? amount.trim() : undefined);
    setBusy(null);
    setConfirmCancel(false);
    if (!r.ok) { setError(r.message); return; }
    primePlan({ plan: r.data.plan, review: r.data.review } as PlanCardData);
    setActive({ kind, planId: r.data.planId });
  }

  if (loadError) {
    return (
      <div className="rounded-2xl border border-border bg-panel p-6 text-center sm:p-8">
        <p className="text-base font-medium text-foreground">{loadError}</p>
        <Link href="/rooms" className="mt-4 inline-flex text-sm font-medium text-primary-ink hover:underline">Browse Live Rooms</Link>
      </div>
    );
  }
  if (!room) return <RoomSkeleton />;

  const statusKey: EscrowStatusKey = room.chain?.status ?? (room.live ? "open" : "pending");
  const s = ESCROW_STATUS[statusKey];
  const sym = room.asset.symbol;
  const v = room.viewer;
  const ben = room.beneficiary.label ?? (v.isBeneficiary ? "you" : shortAddr(room.beneficiary.address));
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/r/${room.id}` : `/r/${room.id}`;
  const signedOut = !wallet.address;

  return (
    <div className="space-y-4">
      {/* ── Title ─────────────────────────────────────────────── */}
      <header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusIndicator tone={s.tone} label={s.label} />
          <span className="text-xs text-muted-foreground">{room.kind === "fixed" ? "Fixed shares" : "Fundraising target"} · {sym}</span>
        </div>
        <h1 className="mt-2 text-balance text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{room.title}</h1>
        {room.description && <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">{room.description}</p>}
        <p className="mt-2 text-xs text-muted-foreground">Collected for <span className="text-foreground" title={room.beneficiary.address}>{ben}</span></p>
      </header>

      {room.unavailable && <Banner tone="warning">{room.unavailable}</Banner>}
      {!room.live && !room.unavailable && (
        <Banner tone="neutral">{v.isCreator ? "Finish creating this room on-chain to open it. Until then nobody can contribute." : "This room isn't live yet — its creator hasn't created it on-chain. Nothing can be contributed."}</Banner>
      )}
      {room.chain && !room.chain.termsMatch && (
        <Banner tone="danger">This room&apos;s on-chain terms don&apos;t match what&apos;s shown here, so PayAI won&apos;t accept contributions to it.</Banner>
      )}
      {room.chainError && <Banner tone="warning">{room.chainError} Progress is hidden until it can be read — nothing is shown that isn&apos;t confirmed.</Banner>}

      {/* ── Progress ──────────────────────────────────────────── */}
      <section aria-label="Progress" className="rounded-2xl border border-border bg-panel p-5 sm:p-6">
        <p className="text-sm text-muted-foreground">Raised</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums] sm:text-4xl">
          {room.chain ? room.chain.raised : "—"} <span className="text-lg font-medium text-muted-foreground">of {room.target} {sym}</span>
        </p>
        <div
          className="mt-4 h-2 overflow-hidden rounded-full bg-input"
          role="progressbar" aria-label="Amount raised" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={room.chain ? Math.min(100, Math.round(room.chain.progressBps / 100)) : undefined}
        >
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: room.chain ? pct(room.chain.progressBps) : "0%" }} />
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <Stat label="Remaining" value={room.chain ? `${room.chain.remaining} ${sym}` : "—"} />
          <Stat label={room.kind === "fixed" ? `Paid of ${room.slots}` : "Contributors"} value={room.chain ? String(room.chain.contributors) : "—"} />
          <Stat label={statusKey === "open" ? timeLeft(room.deadline, now) : "Deadline"} value={new Date(room.deadline).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
        </dl>
        {room.unlistedRaised && (
          <p className="mt-3 text-xs text-muted-foreground">Includes {room.unlistedRaised} {sym} contributed directly to the contract (confirmed on-chain, not listed below).</p>
        )}
      </section>

      {/* ── Messages ──────────────────────────────────────────── */}
      {notice && <p role="status" className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/[0.06] px-4 py-3 text-sm text-foreground"><Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />{notice}</p>}
      {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/[0.06] px-4 py-3 text-sm text-foreground">{error}</p>}

      {/* ── The signing step, when one is under way ───────────── */}
      {active && (
        <section aria-label="Review and sign" className="space-y-2">
          <PlanCard planRef={{ planId: active.planId, kind: "transfer" }} />
          <p className="px-1 text-xs text-muted-foreground">
            The room updates once Monad confirms the transaction. A pending transaction is never counted.{" "}
            <button type="button" onClick={() => void settle()} className="font-medium text-primary-ink hover:underline">Check now</button>
          </p>
        </section>
      )}

      {/* ── Contribute ────────────────────────────────────────── */}
      {!active && room.live && statusKey === "open" && room.chain?.termsMatch && (
        <section aria-label="Contribute" className="rounded-2xl border border-border bg-panel p-5 sm:p-6">
          <h2 className="text-base font-semibold text-foreground">Contribute</h2>
          {signedOut ? (
            <>
              <p className="mt-1 text-pretty text-sm text-muted-foreground">Connect the wallet you&apos;ll pay from, or create a PayAI Wallet. You&apos;ll come straight back here.</p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <Link href={`/connect?next=${encodeURIComponent(`/r/${room.id}`)}`} className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Wallet size={15} aria-hidden />Connect a wallet</Link>
                <Link href={`/auth?next=${encodeURIComponent(`/r/${room.id}`)}`} className="inline-flex h-11 items-center justify-center rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Create a PayAI Wallet</Link>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">A PayAI Wallet uses your device&apos;s passkey; some browsers don&apos;t support it yet — connecting an existing wallet always works.</p>
            </>
          ) : room.kind === "fixed" && v.contributed && v.contributed !== "0" ? (
            <p className="mt-1 text-sm text-foreground">You&apos;ve paid your share of {v.contributed} {sym}. It&apos;s held in escrow.</p>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void start("contribute"); }} className="mt-3">
              {room.kind === "fixed" ? (
                <p className="text-sm text-muted-foreground">Your share: <span className="font-medium text-foreground [font-variant-numeric:tabular-nums]">{room.share} {sym}</span></p>
              ) : (
                <>
                  <label htmlFor="amount" className="text-sm text-muted-foreground">Amount ({sym})</label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={room.minContribution ?? "0"}
                      className="h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-base text-foreground [font-variant-numeric:tabular-nums] focus:outline-none focus:ring-2 focus:ring-ring" />
                    {room.chain && <button type="button" onClick={() => setAmount(room.chain!.remaining)} className="h-11 shrink-0 rounded-md border border-border px-3 text-sm text-foreground hover:bg-input">Remaining</button>}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">{room.minContribution ? `Minimum ${room.minContribution} ${sym} per contribution — or exactly the amount still needed, if that's less. ` : ""}Up to {room.chain?.remaining ?? "—"} {sym}.</p>
                </>
              )}
              <button type="submit" disabled={busy !== null || (room.kind === "target" && !amount.trim())}
                className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                {busy === "contribute" ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Lock size={14} aria-hidden />} Review contribution
              </button>
              <p className="mt-2 text-xs text-muted-foreground">You pay exactly the amount above — you&apos;ll see the exact transaction before signing. PayAI deducts its {feePercent(room.feeBps)} platform fee from the room&apos;s proceeds only if it succeeds. The creator can cancel before the room completes; if that happens, or the deadline passes, you can take your contribution back in full.</p>
            </form>
          )}
        </section>
      )}

      {/* ── Refund ────────────────────────────────────────────── */}
      {!active && v.canRefund && v.refundable && (
        <section aria-label="Refund" className="rounded-2xl border border-border bg-panel p-5 sm:p-6">
          <h2 className="text-base font-semibold text-foreground">Your refund is available</h2>
          <p className="mt-1 text-sm text-muted-foreground">This room {statusKey === "cancelled" ? "was cancelled" : "closed without reaching its goal"}. Take back your {v.refundable} {sym} — the escrow returns it in full, with no fee.</p>
          <button type="button" onClick={() => void start("refund")} disabled={busy !== null}
            className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:w-auto">
            {busy === "refund" ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Undo2 size={15} aria-hidden />} Claim refund
          </button>
        </section>
      )}

      {/* ── Creator management ────────────────────────────────── */}
      {!active && (v.isCreator || v.isBeneficiary) && room.live && (
        <section aria-label="Manage room" className="rounded-2xl border border-primary/25 bg-primary/[0.04] p-5 sm:p-6">
          <h2 className="text-base font-semibold text-foreground">{v.isCreator ? "Your room" : "You're the beneficiary"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{nextStep(statusKey, room)}</p>
          {v.canClaim && room.chain?.claimable && <ClaimPanel room={room} ben={ben} busy={busy} onClaim={() => void start("claim")} />}
          {v.canCancel && !confirmCancel && (
            <button type="button" onClick={() => setConfirmCancel(true)} className="mt-4 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Cancel this room</button>
          )}
          {v.canCancel && confirmCancel && (
            <div role="alertdialog" aria-label="Cancel this room?" className="mt-4 rounded-lg border border-border bg-panel p-4 text-sm">
              <p className="text-foreground">Cancel this room? It can&apos;t be undone. Contributions stop, and everyone who contributed can claim a full refund.</p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
                <button type="button" onClick={() => void start("cancel")} disabled={busy !== null} className="inline-flex h-10 items-center justify-center rounded-md border border-danger/40 px-4 text-sm font-medium text-danger hover:bg-danger/10">{busy === "cancel" ? "Preparing…" : "Yes, cancel"}</button>
                <button type="button" onClick={() => setConfirmCancel(false)} className="inline-flex h-10 items-center justify-center rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-input">Keep it open</button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Anyone may release a completed room's payout (PA-11) ── */}
      {!active && !v.isCreator && !v.isBeneficiary && v.canClaim && room.chain?.claimable && (
        <section aria-label="Release funds" className="rounded-2xl border border-border bg-panel p-5 sm:p-6">
          <h2 className="text-base font-semibold text-foreground">This room is fully funded</h2>
          <p className="mt-1 text-pretty text-sm text-muted-foreground">Anyone can release the payout. It always goes to the room&apos;s beneficiary — you receive nothing and only pay network gas.</p>
          <ClaimPanel room={room} ben={ben} busy={busy} onClaim={() => void start("claim")} />
        </section>
      )}

      {/* ── Share ─────────────────────────────────────────────── */}
      {room.live && <ShareLink url={shareUrl} title={room.title} />}

      {/* ── Activity ──────────────────────────────────────────── */}
      <section aria-label="Activity" className="rounded-2xl border border-border bg-panel p-5 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">Confirmed activity</h2>
        {room.activity.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No confirmed contributions yet.</p>
        ) : (
          <ol className="mt-3 divide-y divide-border/70">
            {[...room.activity].reverse().map((a) => (
              <li key={a.txHash} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="text-foreground">{activityText(a, sym)}</p>
                  <p className="text-xs text-muted-foreground">{fmtWhen(a.at)}</p>
                </div>
                <a href={`${MONAD_EXPLORER}/tx/${a.txHash}`} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-primary-ink hover:underline" aria-label="View transaction">
                  Tx <ExternalLink size={11} aria-hidden />
                </a>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Only transactions confirmed on Monad and verified against the escrow contract are listed. Contributors are numbered, not named.</p>
      </section>

      {/* ── Conditions & disclosures ──────────────────────────── */}
      <section aria-label="Conditions" className="rounded-2xl border border-border bg-panel p-5 sm:p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground"><ShieldCheck size={16} className="text-primary-ink" aria-hidden />How this room works</h2>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
          {room.conditions.map((c) => <li key={c} className="flex gap-2 [overflow-wrap:anywhere]"><span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />{c}</li>)}
        </ul>
        <dl className="mt-4 space-y-1.5 border-t border-border/70 pt-4 text-xs">
          <Row label="Escrow contract"><a href={`${MONAD_EXPLORER}/address/${room.escrow}`} target="_blank" rel="noreferrer" className="font-mono text-primary-ink hover:underline">{shortAddr(room.escrow)}</a></Row>
          {room.chainRoomId && <Row label="Room on-chain">#{room.chainRoomId}</Row>}
          {room.createTx && <Row label="Created in"><a href={`${MONAD_EXPLORER}/tx/${room.createTx}`} target="_blank" rel="noreferrer" className="font-mono text-primary-ink hover:underline">{room.createTx.slice(0, 10)}…</a></Row>}
          <Row label="Token">{room.asset.native ? "MON (native)" : <span className="font-mono">{sym} · {shortAddr(room.asset.address)}</span>}</Row>
          <Row label="Platform fee">{room.feeBps === 0 ? "None" : `${feePercent(room.feeBps)} of successful proceeds · none on contributions or refunds`}</Row>
        </dl>
      </section>
    </div>
  );
}

function ClaimPanel({ room, ben, busy, onClaim }: { room: EscrowRoomView; ben: string; busy: Busy; onClaim: () => void }) {
  const sym = room.asset.symbol;
  const c = room.chain!.claimable!;
  return (
    <div className="mt-4 rounded-lg border border-border bg-panel p-4">
      <dl className="space-y-1.5 text-sm">
        <Row label="Raised">{room.chain!.raised} {sym}</Row>
        <Row label={`PayAI platform fee (${feePercent(room.feeBps)})`}>{c.fee} {sym}</Row>
        <Row label={ben === "you" ? "You receive" : `${ben} receives`}><span className="font-semibold">{c.net} {sym}</span></Row>
      </dl>
      <button type="button" onClick={onClaim} disabled={busy !== null}
        className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {busy === "claim" && <Loader2 size={15} className="animate-spin" aria-hidden />} {ben === "you" ? `Claim ${c.net} ${sym}` : `Release ${c.net} ${sym} to the beneficiary`}
      </button>
    </div>
  );
}

function nextStep(status: EscrowStatusKey, room: EscrowRoomView): string {
  switch (status) {
    case "open": return room.chain && room.chain.contributors === 0 ? "Share the link to start collecting. Funds stay in escrow until the room completes." : "Collecting. Funds stay in escrow until the room completes.";
    case "completed": return "The room is fully funded. Release the funds to pay the beneficiary — anyone can do this, and the money only ever goes to the beneficiary.";
    case "claimed": return "Done — the funds were paid out to the beneficiary.";
    case "expired": return "The deadline passed before the room completed. Contributors can claim refunds; nothing can be claimed.";
    case "cancelled": return "You cancelled this room. Contributors can claim refunds.";
    default: return "";
  }
}

function activityText(a: EscrowRoomView["activity"][number], sym: string): string {
  const who = a.you ? "You" : a.n ? `Contributor ${a.n}` : "Someone";
  switch (a.kind) {
    case "contributed": return `${who} contributed ${a.amount} ${sym}`;
    case "claimed": return `Funds claimed — ${a.amount} ${sym} paid out`;
    case "refunded": return `${a.you ? "You were" : "A contributor was"} refunded ${a.amount} ${sym}`;
    case "cancelled": return "Room cancelled — refunds opened";
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-foreground [font-variant-numeric:tabular-nums]">{value}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-foreground [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Banner({ tone, children }: { tone: "warning" | "neutral" | "danger"; children: React.ReactNode }) {
  const cls = tone === "danger" ? "border-danger/30 bg-danger/[0.06]" : tone === "warning" ? "border-warning/30 bg-warning/[0.06]" : "border-border bg-panel";
  return <p role="status" className={`rounded-lg border px-4 py-3 text-pretty text-sm text-foreground ${cls}`}>{children}</p>;
}

function ShareLink({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <section aria-label="Share" className="flex items-center gap-2 rounded-2xl border border-border bg-panel p-3 pl-4">
      <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{url}</p>
      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* blocked */ } }}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-foreground hover:bg-input">
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? "Copied" : "Copy"}
      </button>
      {canShare && (
        <button type="button" onClick={() => void navigator.share({ title, url }).catch(() => {})} aria-label="Share"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-foreground hover:bg-input">
          <Share2 size={14} aria-hidden />
        </button>
      )}
    </section>
  );
}

function RoomSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading room">
      <div className="h-6 w-24 animate-pulse rounded bg-input" />
      <div className="h-8 w-2/3 animate-pulse rounded bg-input" />
      <div className="h-40 animate-pulse rounded-2xl bg-panel" />
      <div className="h-32 animate-pulse rounded-2xl bg-panel" />
    </div>
  );
}
