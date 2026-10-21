"use client";

import { RoomsGate } from "@/components/rooms/RoomsGate";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { EmptyState, PageHeader, StatusIndicator } from "@/components/dashboard/primitives";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { createRoom, listAllRooms, previewRoom, type EscrowSummary, type RoomPreviewDTO, type RoomSummary } from "@/lib/rooms/client";
import { ROOM_STATUS, shortAddr } from "@/components/rooms/format";
import { composeRoomRequest, MAX_EXPIRY_DAYS, MAX_PARTICIPANTS, MIN_PARTICIPANTS } from "@/lib/rooms/terms";
import { ESCROW_STATUS } from "@/components/rooms/escrow/format";
import { Segments } from "@/components/rooms/Segments";
import { EscrowCreateForm } from "@/components/rooms/escrow/EscrowCreateForm";

/**
 * Rooms: split a cost with a link. Each share is paid straight from the person
 * paying to the recipient through the ordinary plan flow; PayAI never holds
 * the money. Escrow rooms (funds held by the PayAIRoomEscrow contract) are
 * offered only when the server says this wallet may create one.
 *
 * Creating a room is not a transaction: the form's fields are written as the
 * same sentence Ask PayAI accepts (composeRoomRequest), read and checked by the
 * server (lib/rooms/terms.ts), previewed, and stored only when confirmed.
 */
export default function RoomsPage() {
  return <RoomsGate><RoomsPageInner /></RoomsGate>;
}

function RoomsPageInner() {
  const wallet = useWalletService();
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [symbol, setSymbol] = useState("USDC");
  const [per, setPer] = useState<"total" | "each">("total");
  const [people, setPeople] = useState("2");
  const [recipient, setRecipient] = useState("");
  const [days, setDays] = useState("7");
  const ready = /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) > 0 && /^\d+$/.test(people) && /^\d+$/.test(days);
  const text = ready ? composeRoomRequest({ amount, symbol, per, participants: Number(people), recipient, expiryDays: Number(days) }) : "";
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPreview(null); };
  const [memo, setMemo] = useState("");
  const [preview, setPreview] = useState<RoomPreviewDTO | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [escrowRooms, setEscrowRooms] = useState<EscrowSummary[]>([]);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [escrowCreate, setEscrowCreate] = useState(false);

  useEffect(() => {
    if (!wallet.address) return;
    let live = true;
    void listAllRooms().then((r) => {
      if (!live) return;
      if (r.ok) { setRooms(r.data.rooms); setEscrowRooms(r.data.escrowRooms); setEscrowCreate(r.data.escrowCreate.available); setRoomsError(null); } else { setRooms(null); setRoomsError(r.status === 401 ? "Unlock your wallet to see your rooms." : r.message); }
    });
    return () => { live = false; };
  }, [wallet.address]);

  async function onPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy("preview"); setError(null); setPreview(null);
    const r = await previewRoom(text.trim());
    setBusy(null);
    if (r.ok) setPreview(r.data); else setError(r.status === 401 ? "Unlock your wallet to create a room." : r.message);
  }

  async function onCreate() {
    if (busy) return;
    setBusy("create"); setError(null);
    const r = await createRoom(text.trim(), memo.trim());
    setBusy(null);
    if (r.ok) router.push(`/dashboard/rooms/${r.data.id}`);
    else setError(r.message);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Rooms" description="Split a cost with a link. Each person pays their share straight to the recipient." />

      <section aria-labelledby="room-new" className="rounded-xl surface-purple p-5 sm:p-7">
        <h2 id="room-new" className="text-lg font-semibold leading-snug tracking-tight text-foreground">Start a room</h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">
          Set the amount, how many people pay, and who receives it.
        </p>

        {!preview ? (
          <form onSubmit={onPreview} className="mt-5 space-y-3">
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="Amount">
                <input inputMode="decimal" value={amount} onChange={(e) => edit(setAmount)(e.target.value)} placeholder="100" className={INPUT} />
              </Field>
              <Field label="Token">
                <select value={symbol} onChange={(e) => edit(setSymbol)(e.target.value)} className={`${INPUT} pr-9`}>
                  <option value="USDC">USDC</option>
                  <option value="MON">MON</option>
                </select>
              </Field>
            </div>
            <div role="radiogroup" aria-label="The amount is" className="grid grid-cols-2 gap-2">
              {([["total", "The total", "Split equally"], ["each", "Each share", "Every person pays this"]] as const).map(([k, t, d]) => (
                <button key={k} type="button" role="radio" aria-checked={per === k} onClick={() => edit(setPer)(k)}
                  className={`rounded-lg border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${per === k ? "border-foreground bg-panel" : "border-border hover:bg-panel/60"}`}>
                  <span className="block text-sm font-medium text-foreground">{t}</span>
                  <span className="block text-sm text-muted-foreground">{d}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="People paying">
                <input type="number" inputMode="numeric" min={MIN_PARTICIPANTS} max={MAX_PARTICIPANTS} value={people} onChange={(e) => edit(setPeople)(e.target.value)} className={INPUT} />
              </Field>
              <Field label="Open for (days)">
                <input type="number" inputMode="numeric" min={1} max={MAX_EXPIRY_DAYS} value={days} onChange={(e) => edit(setDays)(e.target.value)} className={INPUT} />
              </Field>
            </div>
            <Field label="Goes to" hint="(optional, you if empty)">
              <input value={recipient} onChange={(e) => edit(setRecipient)(e.target.value)} placeholder="bob.nad or 0x…" maxLength={64} autoComplete="off" spellCheck={false} className={INPUT} />
            </Field>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-foreground">What it&apos;s for <span className="font-normal text-muted-foreground">(optional)</span></span>
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Team dinner"
                maxLength={80}
                className="h-12 w-full rounded-lg border border-border bg-panel px-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button type="submit" disabled={!ready || busy != null || !wallet.address} className={PRIMARY}>
                {busy === "preview" && <Loader2 size={14} className="animate-spin" aria-hidden />} Preview
              </button>
              {!wallet.address ? <span className="text-sm text-muted-foreground">Connect or unlock your wallet to create a room.</span>
                : <Link href="/dashboard/ask" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Or describe it in Ask PayAI</Link>}
            </div>
          </form>
        ) : (
          <div className="mt-5">
            <dl className="divide-y divide-border rounded-lg bg-panel text-[15px]">
              <Row k="Total" v={<span className="tabular-nums">{preview.total} {preview.symbol}</span>} />
              <Row k="Each person pays" v={<span className="tabular-nums">{preview.share} {preview.symbol}</span>} />
              <Row k="People paying" v={preview.participants} />
              <Row k="Goes to" v={
                preview.recipient.isCreator ? "You" : (
                  <span className="break-all">{preview.recipient.label ?? shortAddr(preview.recipient.address)}{preview.recipient.label && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{shortAddr(preview.recipient.address)}</span>}</span>
                )
              } />
              <Row k="Open for" v={`${preview.expiresInDays} day${preview.expiresInDays === 1 ? "" : "s"}`} />
            </dl>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Anyone with the link can join; people aren&apos;t identity-verified. Each share goes straight to the recipient,
              with PayAI&apos;s fee added on top for the person paying. PayAI never holds the money, so there&apos;s no escrow and nothing is
              refunded if the room closes early. Creating the room moves no funds.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={onCreate} disabled={busy != null} className={PRIMARY}>
                {busy === "create" && <Loader2 size={14} className="animate-spin" aria-hidden />} Create room
              </button>
              <button type="button" onClick={() => setPreview(null)} disabled={busy != null} className={SECONDARY}>Edit</button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      </section>

      {escrowCreate && (
        <div className="mt-6">
          <EscrowCreateForm symbols={["USDC", "MON"]} disabledReason={null} />
        </div>
      )}

      <section aria-labelledby="rooms-mine" className="mt-10">
        <h2 id="rooms-mine" className="mb-3 text-base font-semibold tracking-tight text-foreground">Your rooms</h2>
        {roomsError ? (
          <p className="text-sm text-muted-foreground">{roomsError}</p>
        ) : !wallet.address ? (
          <EmptyState compact title="No rooms to show yet" hint="Connect or unlock your wallet to see rooms you started or joined." />
        ) : rooms == null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rooms.length === 0 && escrowRooms.length === 0 ? (
          <EmptyState compact title="No rooms yet" hint="Rooms you start or join appear here." />
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {escrowRooms.map((r) => (
              <li key={r.id}>
                <Link href={`/dashboard/rooms/${r.id}`} className={ROW_LINK}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{r.title}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      <StatusIndicator tone={ESCROW_STATUS[r.status].tone} label={ESCROW_STATUS[r.status].label} />
                      <span className="tabular-nums">{r.raised ?? "—"} of {r.target} {r.symbol}</span>
                      <span>{r.role === "creator" ? "You started it" : "You contributed"}</span>
                    </span>
                  </span>
                  <ArrowRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
            {rooms.map((r) => (
              <li key={r.id}>
                <Link href={`/dashboard/rooms/${r.id}`} className={ROW_LINK}>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-medium text-foreground">{r.memo ?? `Room for ${r.total} ${r.symbol}`}</span>
                      <span className="shrink-0 text-sm tabular-nums text-foreground">{r.paid} of {r.target} paid</span>
                    </span>
                    <Segments paid={r.paid} target={r.target} className="mt-2.5" />
                    <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                      <StatusIndicator tone={ROOM_STATUS[r.status].tone} label={ROOM_STATUS[r.status].label} />
                      <span className="tabular-nums">{r.share} {r.symbol} each</span>
                      <span>{r.role === "creator" ? "You started it" : "You joined"}</span>
                    </span>
                  </span>
                  <ArrowRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-foreground">{label}{hint && <span className="font-normal text-muted-foreground"> {hint}</span>}</span>
      {children}
    </label>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 text-right text-foreground">{v}</dd>
    </div>
  );
}

const INPUT = "h-12 w-full rounded-lg border border-border bg-panel px-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const PRIMARY = "inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const SECONDARY = "inline-flex h-11 items-center gap-2 rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const ROW_LINK = "flex items-center gap-4 py-4 transition-colors hover:bg-input/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-2";
