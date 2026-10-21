"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { StatusIndicator } from "@/components/dashboard/primitives";
import { PlanCard } from "@/components/ask/PlanCard";
import { primePlan, type PlanCardData } from "@/lib/ask/planCards";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import {
  confirmShare, createRoom, getRoom, joinRoom, listAllRooms, payShare, previewRoom,
  type EscrowSummary, type RoomPreviewDTO, type RoomSummary, type RoomView,
} from "@/lib/rooms/client";
import { EscrowRoomAskCard } from "@/components/ask/EscrowRoomAskCard";
import { ESCROW_STATUS } from "@/components/rooms/escrow/format";
import type { AskRoomRef } from "@/lib/ask/types";
import { ROOM_STATUS, shortAddr } from "@/components/rooms/format";

/**
 * A room in Ask PayAI's chat. Every value shown comes from the Rooms API —
 * never from the message text — and every change is an explicit button:
 * create (no funds), join (no funds), and pay my share, which is the
 * existing plan card (review → approve → quote review → your wallet signs).
 * Nothing here signs or sends anything.
 *
 * A room id is used only when the user wrote one; otherwise the card asks,
 * offering the user's REAL rooms (or asking for the link to join one).
 */
export function RoomAskCard({ room: ref, messageId }: { room: AskRoomRef; messageId: string }) {
  const wallet = useWalletService();
  if (!wallet.address) {
    return <Shell><p className="text-muted-foreground">Unlock your wallet to use Rooms.</p></Shell>;
  }
  if (ref.action === "create") return <CreateRoom text={ref.text ?? ""} messageId={messageId} />;
  if (ref.action === "list") return <RoomList />;
  return <RoomAction action={ref.action} roomId={ref.roomId} />;
}

const CREATED_KEY = (messageId: string) => `payai_ask_room_created:${messageId}`;

function CreateRoom({ text, messageId }: { text: string; messageId: string }) {
  const [preview, setPreview] = useState<RoomPreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A restored conversation shows the room this card already created — it
  // never offers to create it a second time.
  const [createdId, setCreatedId] = useState<string | null>(() => {
    try { return localStorage.getItem(CREATED_KEY(messageId)); } catch { return null; }
  });

  useEffect(() => {
    if (createdId) return;
    let live = true;
    void previewRoom(text).then((r) => { if (!live) return; if (r.ok) setPreview(r.data); else setError(r.message); });
    return () => { live = false; };
  }, [text, createdId]);

  async function create() {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await createRoom(text, "");
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    try { localStorage.setItem(CREATED_KEY(messageId), r.data.id); } catch { /* the link below still works */ }
    setCreatedId(r.data.id);
  }

  if (createdId) {
    return (
      <Shell>
        <p className="flex items-center gap-2 text-foreground"><Check size={14} aria-hidden className="text-primary-ink" /> Room created.</p>
        <p className="mt-1 text-muted-foreground">Share its link so people can join and pay their share.</p>
        <OpenLink id={createdId} />
      </Shell>
    );
  }
  if (error) return <Shell><p role="alert" className="text-foreground">{error}</p><p className="mt-1 text-muted-foreground">Nothing was created.</p></Shell>;
  if (!preview) return <Shell><Loading /></Shell>;
  return (
    <Shell>
      <Terms rows={[
        ["Total", `${preview.total} ${preview.symbol}`],
        ["Each person pays", `${preview.share} ${preview.symbol}`],
        ["People paying", String(preview.participants)],
        ["Goes to", preview.recipient.isCreator ? "You" : preview.recipient.label ?? shortAddr(preview.recipient.address)],
        ["Open for", `${preview.expiresInDays} day${preview.expiresInDays === 1 ? "" : "s"}`],
      ]} />
      <Honesty />
      <button type="button" onClick={create} disabled={busy} className={PRIMARY}>
        {busy && <Loader2 size={14} className="animate-spin" aria-hidden />} Create room
      </button>
    </Shell>
  );
}

function RoomList({ onPick, emptyHint }: { onPick?: (id: string) => void; emptyHint?: string }) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [escrowRooms, setEscrowRooms] = useState<EscrowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void listAllRooms().then((r) => { if (!live) return; if (r.ok) { setRooms(r.data.rooms); setEscrowRooms(r.data.escrowRooms); } else setError(r.message); });
    return () => { live = false; };
  }, []);
  if (error) return <Shell><p className="text-foreground">{error}</p></Shell>;
  if (!rooms) return <Shell><Loading /></Shell>;
  if (rooms.length === 0 && escrowRooms.length === 0) return <Shell><p className="text-foreground">You haven&apos;t created or joined any rooms yet.</p>{emptyHint && <p className="mt-1 text-muted-foreground">{emptyHint}</p>}</Shell>;
  return (
    <Shell flush>
      <ul className="divide-y divide-border">
        {escrowRooms.slice(0, 8).map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <span className="block truncate text-foreground">{r.title}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <StatusIndicator tone={ESCROW_STATUS[r.status].tone} label={ESCROW_STATUS[r.status].label} />
                <span className="tabular-nums">{r.raised ?? "—"} of {r.target} {r.symbol}</span>
                <span>· Escrow</span>
              </span>
            </span>
            {onPick
              ? <button type="button" onClick={() => onPick(r.id)} className={SECONDARY}>Choose</button>
              : <Link href={`/r/${r.id}`} aria-label="Open room" className="shrink-0 text-muted-foreground hover:text-foreground"><ArrowRight size={14} aria-hidden /></Link>}
          </li>
        ))}
        {rooms.slice(0, 8).map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="min-w-0">
              <span className="block truncate text-foreground">{r.memo ?? `Room for ${r.total} ${r.symbol}`}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <StatusIndicator tone={ROOM_STATUS[r.status].tone} label={ROOM_STATUS[r.status].label} />
                <span className="tabular-nums">{r.paid} of {r.target} paid</span>
                <span>· {r.share} {r.symbol} each</span>
              </span>
            </span>
            {onPick
              ? <button type="button" onClick={() => onPick(r.id)} className={SECONDARY}>Choose</button>
              : <Link href={`/dashboard/rooms/${r.id}`} aria-label="Open room" className="shrink-0 text-muted-foreground hover:text-foreground"><ArrowRight size={14} aria-hidden /></Link>}
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function RoomAction({ action, roomId }: { action: "status" | "join" | "contribute"; roomId: string | null }) {
  const [id, setId] = useState<string | null>(roomId);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"join" | "pay" | "confirm" | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (rid: string) => {
    const r = await getRoom(rid);
    if (r.ok) { setRoom(r.data); setPlanId((p) => p ?? r.data.viewer.planId); } else setError(r.status === 404 ? "That room doesn't exist." : r.message);
  }, []);
  useEffect(() => { if (id && !id.startsWith("er_")) queueMicrotask(() => void load(id)); }, [id, load]);

  // Escrow rooms: the same escrow Rooms API as the room page.
  if (id && id.startsWith("er_")) return <EscrowRoomAskCard id={id} action={action} />;

  if (!id) {
    // Never a guessed room: joining needs the link someone shared; otherwise
    // the user picks from their own rooms.
    if (action === "join") return <Shell><p className="text-foreground">Which room? Paste the room&apos;s link or its id (room_…) — PayAI only joins a room you were invited to.</p></Shell>;
    return <RoomList onPick={setId} emptyHint="Create one by describing it, for example “create a room for 100 USDC for 5 people”." />;
  }
  if (error) return <Shell><p role="alert" className="text-foreground">{error}</p></Shell>;
  if (!room) return <Shell><Loading /></Shell>;

  const v = room.viewer;
  const sym = room.asset.symbol;
  const mine = room.slots.find((s) => s.you) ?? null;

  async function act(kind: "join" | "pay" | "confirm") {
    if (busy) return;
    setBusy(kind); setError(null); setNotice(null);
    if (kind === "pay") {
      const r = await payShare(room!.id);
      setBusy(null);
      if (!r.ok) { setNotice(r.message); return; }
      primePlan({ plan: r.data.plan, review: r.data.review } as PlanCardData);
      setPlanId(r.data.planId);
      return;
    }
    const r = kind === "join" ? await joinRoom(room!.id) : await confirmShare(room!.id);
    setBusy(null);
    if (r.ok) { setRoom(r.data); if (kind === "confirm") setNotice("Your share is counted."); } else setNotice(r.message);
  }

  return (
    <div className="space-y-3">
      <Shell>
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 truncate font-medium text-foreground">{room.memo ?? `Room for ${room.total} ${sym}`}</p>
          <StatusIndicator tone={ROOM_STATUS[room.status].tone} label={ROOM_STATUS[room.status].label} />
        </div>
        <Terms rows={[
          ["Progress", `${room.paid} of ${room.target} paid · ${room.joined} joined`],
          ["Each share", `${room.share} ${sym}`],
          ["Goes to", v.isRecipient ? "You" : room.recipient.label ?? shortAddr(room.recipient.address)],
          ["Your part", v.isRecipient ? "You're the recipient" : mine ? (mine.state === "paid" ? "Paid" : mine.state === "paying" ? "Payment started" : "Joined, not paid") : "Not joined"],
        ]} />

        {action === "join" && !mine && !v.isRecipient && (v.canJoin
          ? <button type="button" onClick={() => act("join")} disabled={busy != null} className={PRIMARY}>{busy === "join" && <Loader2 size={14} className="animate-spin" aria-hidden />} Join room</button>
          : <p className="mt-3 text-muted-foreground">{room.status !== "open" ? `This room is ${room.status}, so it can't be joined.` : "This room is full."}</p>)}

        {action === "contribute" && !v.isRecipient && (
          !mine ? (v.canJoin
            ? <><p className="mt-3 text-muted-foreground">Join the room first — joining moves no funds.</p><button type="button" onClick={() => act("join")} disabled={busy != null} className={PRIMARY}>{busy === "join" && <Loader2 size={14} className="animate-spin" aria-hidden />} Join room</button></>
            : <p className="mt-3 text-muted-foreground">You haven&apos;t joined this room{room.status !== "open" ? `, and it's ${room.status}` : ", and it's full"}.</p>)
          : mine.state === "paid" ? <p className="mt-3 text-muted-foreground">Your share is already paid.</p>
          : planId ? null
          : v.canPay ? (
            <>
              <p className="mt-3 text-muted-foreground">Your {room.share} {sym} share is paid as an ordinary PayAI transfer to the recipient, with PayAI&apos;s fee added on top. You&apos;ll review it before signing.</p>
              <button type="button" onClick={() => act("pay")} disabled={busy != null} className={PRIMARY}>{busy === "pay" && <Loader2 size={14} className="animate-spin" aria-hidden />} Prepare my payment</button>
            </>
          ) : <p className="mt-3 text-muted-foreground">This room is {room.status}; shares can&apos;t be paid any more.</p>
        )}

        {notice && <p role="status" className="mt-3 text-foreground">{notice}</p>}
        <OpenLink id={room.id} />
      </Shell>

      {action === "contribute" && planId && mine?.state !== "paid" && (
        <>
          <PlanCard planRef={{ planId, kind: "transfer" }} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => act("confirm")} disabled={busy != null} className={SECONDARY}>
              {busy === "confirm" && <Loader2 size={14} className="animate-spin" aria-hidden />} Confirm payment
            </button>
            <span className="text-xs text-muted-foreground">Once the payment completes, confirm it to count your share.</span>
          </div>
        </>
      )}
    </div>
  );
}

function Shell({ children, flush = false }: { children: React.ReactNode; flush?: boolean }) {
  return <div className={`rounded-lg border border-border bg-panel text-sm ${flush ? "" : "px-4 py-3.5"}`}>{children}</div>;
}
function Terms({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="mt-2 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words tabular-nums text-foreground">{v}</dd></div>)}
    </dl>
  );
}
function Honesty() {
  return (
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
      An open room: participants aren&apos;t identity-verified. Each share goes straight to the recipient when it&apos;s paid, with
      PayAI&apos;s fee added on top — PayAI never holds the money, so there&apos;s no escrow and nothing is refunded.
    </p>
  );
}
function OpenLink({ id }: { id: string }) {
  return (
    <Link href={`/dashboard/rooms/${id}`} className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      Open room <ArrowRight size={13} aria-hidden />
    </Link>
  );
}
function Loading() {
  return <p className="flex items-center gap-2 text-muted-foreground"><Loader2 size={14} className="animate-spin" aria-hidden /> Checking with PayAI…</p>;
}

const PRIMARY = "mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
const SECONDARY = "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
