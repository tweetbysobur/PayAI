"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { EmptyState, PageHeader, StatusIndicator } from "@/components/dashboard/primitives";
import { PlanCard } from "@/components/ask/PlanCard";
import { primePlan, type PlanCardData } from "@/lib/ask/planCards";
import { getPlanWithReview } from "@/lib/plans-client/api";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import { cancelRoom, confirmShare, getRoom, joinRoom, payShare, type RoomView } from "@/lib/rooms/client";
import { fmtWhen, ROOM_STATUS, shortAddr } from "@/components/rooms/format";
import { EscrowRoom } from "@/components/rooms/escrow/EscrowRoom";

/**
 * One room. Everyone with the link sees the terms and progress; nobody sees
 * another participant's address or transaction (spec §11.11).
 *
 * Paying a share is the existing plan card (components/ask/PlanCard): the
 * server writes the transfer from the room's terms; the participant reviews
 * the quote and signs in their own wallet. This page never signs or sends.
 * Once the plan completes, "Confirm payment" asks the server to count it
 * from the plan's verified on-chain result.
 */
export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  if (/^er_[0-9a-f]{24}$/.test(id)) {
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink />
        <EscrowRoom id={id} />
      </div>
    );
  }
  return <DirectRoom id={id} />;
}

/** A direct (no-escrow) room — the original Rooms model, unchanged. */
function DirectRoom({ id }: { id: string }) {
  const wallet = useWalletService();
  const [room, setRoom] = useState<RoomView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"join" | "pay" | "confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [copied, setCopied] = useState(false);
  const autoConfirmed = useRef(false);

  const reload = useCallback(async () => {
    const r = await getRoom(id);
    if (r.ok) { setRoom(r.data); setLoadError(null); if (r.data.viewer.planId) setPlanId((p) => p ?? r.data.viewer.planId); }
    else setLoadError(r.status === 404 ? "This room doesn't exist." : r.message);
    return r;
  }, [id]);

  useEffect(() => { queueMicrotask(() => void reload()); }, [reload, wallet.address]);

  // A share whose plan already finished (e.g. paid, then the page reloaded)
  // is counted without another click — once per visit; the server decides.
  useEffect(() => {
    const pid = room?.viewer.planId;
    if (!pid || autoConfirmed.current || !room.viewer.slot) return;
    autoConfirmed.current = true;
    void getPlanWithReview(pid).then(async (p) => {
      const state = (p.body as { plan?: { state?: string } } | null)?.plan?.state;
      if (p.status !== 200 || state !== "completed") return;
      const r = await confirmShare(id);
      if (r.ok) setRoom(r.data);
    });
  }, [room, id]);

  async function act(kind: "join" | "pay" | "confirm" | "cancel") {
    if (busy) return;
    setBusy(kind); setError(null); setNotice(null);
    if (kind === "pay") {
      const r = await payShare(id);
      setBusy(null);
      if (!r.ok) { setError(r.message); return; }
      primePlan({ plan: r.data.plan, review: r.data.review } as PlanCardData);
      setPlanId(r.data.planId);
      await reload();
      return;
    }
    const r = kind === "join" ? await joinRoom(id) : kind === "confirm" ? await confirmShare(id) : await cancelRoom(id);
    setBusy(null);
    setConfirmCancel(false);
    if (r.ok) {
      setRoom(r.data);
      if (kind === "confirm") setNotice("Your share is counted.");
    } else {
      setError(r.code === "NOT_SETTLED" && kind === "confirm" ? r.message : r.message);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/dashboard/rooms/${id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the address bar has the link */ }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl">
        <BackLink />
        <EmptyState title={loadError} action={{ label: "Go to Rooms", href: "/dashboard/rooms" }} />
      </div>
    );
  }
  if (!room) return <div className="mx-auto max-w-3xl"><BackLink /><p className="text-sm text-muted-foreground">Loading…</p></div>;

  const s = ROOM_STATUS[room.status];
  const sym = room.asset.symbol;
  const v = room.viewer;
  const mine = room.slots.find((x) => x.you) ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <BackLink />
      <PageHeader
        title={room.memo ?? `Room for ${room.total} ${sym}`}
        description={`${room.share} ${sym} from each of ${room.target} people, paid straight to ${room.recipient.label ?? (v.isRecipient ? "you" : shortAddr(room.recipient.address))}.`}
        actions={<StatusIndicator tone={s.tone} label={s.label} />}
      />

      {/* Progress: one segment per person — paid, joined, or open. */}
      <section aria-label="Progress" className="rounded-lg border border-border bg-panel px-5 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-sm text-foreground"><span className="tabular-nums font-medium">{room.paid}</span> of {room.target} paid</p>
          <p className="text-xs tabular-nums text-muted-foreground">{room.joined} joined</p>
        </div>
        <ol className="mt-3 flex gap-1" aria-hidden>
          {Array.from({ length: room.target }, (_, i) => {
            const slot = room.slots[i];
            const cls = slot?.state === "paid" ? "bg-primary" : slot ? "border border-primary/60" : "border border-dashed border-border";
            return <li key={i} className={`h-2 flex-1 rounded-sm ${cls}`} />;
          })}
        </ol>
        <dl className="mt-4 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Total</dt><dd className="tabular-nums text-foreground">{room.total} {sym}</dd>
          <dt className="text-muted-foreground">Each share</dt><dd className="tabular-nums text-foreground">{room.share} {sym}</dd>
          <dt className="text-muted-foreground">Goes to</dt>
          <dd className="min-w-0 text-foreground">
            {v.isRecipient ? "You " : room.recipient.label ? `${room.recipient.label} ` : null}
            <a href={`${MONAD_EXPLORER}/address/${room.recipient.address}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted-foreground hover:text-foreground">{shortAddr(room.recipient.address)}</a>
          </dd>
          <dt className="text-muted-foreground">{room.status === "open" ? "Closes" : room.status === "completed" ? "Completed" : room.status === "cancelled" ? "Cancelled" : "Closed"}</dt>
          <dd className="text-foreground">{fmtWhen(room.status === "completed" && room.completedAt ? room.completedAt : room.status === "cancelled" && room.cancelledAt ? room.cancelledAt : room.expiresAt)}</dd>
          <dt className="text-muted-foreground">Participants</dt><dd className="text-foreground">Not identity-verified (open room)</dd>
        </dl>
      </section>

      {/* Your part. */}
      <section aria-labelledby="room-you" className="mt-6">
        <h2 id="room-you" className="mb-3 text-sm font-semibold text-foreground">Your part</h2>
        <div className="rounded-lg border border-border px-5 py-4 text-sm">
          {!v.signedIn ? (
            <p className="text-muted-foreground">Unlock your wallet to join this room or pay your share.</p>
          ) : v.isRecipient ? (
            <p className="text-muted-foreground">You&apos;re the recipient — shares are paid to you, so you don&apos;t pay one.</p>
          ) : mine?.state === "paid" ? (
            <p className="flex flex-wrap items-center gap-x-2 text-foreground">
              <Check size={14} aria-hidden className="text-primary-ink" /> You paid your {room.share} {sym} share{mine.paidAt ? ` on ${fmtWhen(mine.paidAt)}` : ""}.
              {mine.txHash && <a href={`${MONAD_EXPLORER}/tx/${mine.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">{shortAddr(mine.txHash)} <ExternalLink size={10} aria-hidden /></a>}
              {mine.afterClose && <span className="text-muted-foreground">It arrived after the room closed.</span>}
            </p>
          ) : v.canJoin ? (
            <>
              <p className="text-muted-foreground">Join to take one of the {room.target - room.joined} open places. Joining moves no funds.</p>
              <button type="button" onClick={() => act("join")} disabled={busy != null} className={PRIMARY}>
                {busy === "join" && <Loader2 size={14} className="animate-spin" aria-hidden />} Join room
              </button>
            </>
          ) : mine ? (
            <>
              <p className="text-foreground">Your share: <span className="tabular-nums font-medium">{room.share} {sym}</span></p>
              <p className="mt-1 text-muted-foreground">
                It&apos;s paid as an ordinary PayAI transfer to the recipient. You&apos;ll review it — including PayAI&apos;s fee,
                added on top — and sign it in your own wallet.
              </p>
              {planId ? null : v.canPay ? (
                <button type="button" onClick={() => act("pay")} disabled={busy != null} className={PRIMARY}>
                  {busy === "pay" && <Loader2 size={14} className="animate-spin" aria-hidden />} Pay my share
                </button>
              ) : (
                <p className="mt-2 text-muted-foreground">This room is {room.status}; shares can&apos;t be paid any more.</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">{room.status === "open" ? "This room is full." : `This room is ${room.status}.`}</p>
          )}
          {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
          {notice && <p role="status" className="mt-3 text-foreground">{notice}</p>}
        </div>

        {planId && mine?.state !== "paid" && (
          <div className="mt-3">
            <PlanCard planRef={{ planId, kind: "transfer" }} />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => act("confirm")} disabled={busy != null} className={SECONDARY}>
                {busy === "confirm" && <Loader2 size={14} className="animate-spin" aria-hidden />} Confirm payment
              </button>
              <span className="text-xs text-muted-foreground">After the payment completes, confirm it to count your share.</span>
            </div>
          </div>
        )}
      </section>

      {/* Participants — numbered places, never addresses. */}
      <section aria-labelledby="room-people" className="mt-8">
        <h2 id="room-people" className="mb-3 text-sm font-semibold text-foreground">Participants</h2>
        {room.slots.length === 0 ? (
          <EmptyState compact title="Nobody has joined yet." hint={v.isCreator ? "Share the link so people can join." : undefined} />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {room.slots.map((p) => (
              <li key={p.slot} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <span className="text-foreground">Participant {p.slot}{p.you && <span className="ml-1.5 text-muted-foreground">(you)</span>}</span>
                <span className="flex items-center gap-3">
                  {p.state === "paid" && p.paidAt && <span className="hidden text-xs text-muted-foreground sm:inline">{fmtWhen(p.paidAt)}</span>}
                  <StatusIndicator
                    tone={p.state === "paid" ? "success" : room.status === "open" ? "pending" : "neutral"}
                    label={p.state === "paid" ? (p.afterClose ? "Paid late" : "Paid") : p.state === "paying" ? "Paying" : room.status === "open" ? "Joined" : "Not paid"}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Activity. */}
      <section aria-labelledby="room-activity" className="mt-8">
        <h2 id="room-activity" className="mb-3 text-sm font-semibold text-foreground">Activity</h2>
        <ol className="space-y-2 border-l border-border pl-4 text-sm">
          {[...room.activity].reverse().map((a, i) => (
            <li key={i} className="flex flex-wrap justify-between gap-x-4">
              <span className="text-foreground">{activityText(a, room)}</span>
              <span className="text-xs text-muted-foreground">{fmtWhen(a.at)}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* Creator. */}
      {v.isCreator && (room.status === "open" || v.canCancel) && (
        <section aria-labelledby="room-manage" className="mt-8">
          <h2 id="room-manage" className="mb-3 text-sm font-semibold text-foreground">Manage</h2>
          <div className="flex flex-wrap items-center gap-2">
            {room.status === "open" && (
              <button type="button" onClick={copyLink} className={SECONDARY}>
                {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? "Link copied" : "Copy invite link"}
              </button>
            )}
            {v.canCancel && !confirmCancel && (
              <button type="button" onClick={() => setConfirmCancel(true)} className={QUIET}>Cancel room</button>
            )}
            {confirmCancel && (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Cancel this room? Nobody will be able to join or pay.</span>
                <button type="button" onClick={() => act("cancel")} disabled={busy != null} className={DANGER}>
                  {busy === "cancel" && <Loader2 size={14} className="animate-spin" aria-hidden />} Cancel room
                </button>
                <button type="button" onClick={() => setConfirmCancel(false)} className={QUIET}>Keep it</button>
              </span>
            )}
          </div>
        </section>
      )}

      <p className="mt-8 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        Each share goes directly from the person paying to the recipient when it&apos;s paid. PayAI never holds room funds:
        there&apos;s no escrow, and if the room is cancelled or expires, shares already paid stay with the recipient.
        A share counts only once PayAI has checked it on Monad.
      </p>
    </div>
  );
}

function activityText(a: RoomView["activity"][number], room: RoomView): string {
  const who = a.slot == null ? "" : a.you ? "You" : `Participant ${a.slot}`;
  switch (a.kind) {
    case "created": return a.you ? "You created the room" : "Room created";
    case "joined": return `${who} joined`;
    case "paid": return `${who} paid ${room.share} ${room.asset.symbol}`;
    case "cancelled": return "Room cancelled";
    case "completed": return "Every share paid — room completed";
    case "expired": return "Room expired";
  }
}

function BackLink() {
  return (
    <Link href="/dashboard/rooms" className="mb-4 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ArrowLeft size={14} aria-hidden /> Rooms
    </Link>
  );
}

const PRIMARY = "mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
const SECONDARY = "inline-flex h-10 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
const QUIET = "inline-flex h-10 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const DANGER = "inline-flex h-10 items-center gap-2 rounded-md border border-danger/50 px-4 text-sm font-medium text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
