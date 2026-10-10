"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { EmptyState, PageHeader, StatusIndicator } from "@/components/dashboard/primitives";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { createRoom, listAllRooms, listLiveRooms, previewRoom, type EscrowSummary, type RoomPreviewDTO, type RoomSummary } from "@/lib/rooms/client";
import { ROOM_STATUS, shortAddr } from "@/components/rooms/format";
import { EscrowCreateForm } from "@/components/rooms/escrow/EscrowCreateForm";
import { ESCROW_STATUS } from "@/components/rooms/escrow/format";

/**
 * Rooms. Two kinds:
 *   - escrow rooms (fixed shares or a fundraising target) — funds held by the
 *     PayAIRoomEscrow contract until the room completes, refundable if it
 *     doesn't. Available only once a reviewed escrow is configured; until then
 *     the form says so and is disabled (docs/rooms/ESCROW_AUDIT.md).
 *   - direct splits (the original model) — each share paid straight to the
 *     recipient, no escrow, no refunds. Spec: docs/hackathon/payai-rooms-cleanverse.md §16.
 *
 * Creating a room is not a transaction: the request is read deterministically
 * by the server (lib/rooms/terms.ts), previewed, and only stored when the
 * creator confirms. Nothing here signs or sends anything; paying a share
 * happens on the room's own page, through the existing plan card.
 */
export default function RoomsPage() {
  const wallet = useWalletService();
  const router = useRouter();
  const [text, setText] = useState("");
  const [memo, setMemo] = useState("");
  const [preview, setPreview] = useState<RoomPreviewDTO | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [escrowRooms, setEscrowRooms] = useState<EscrowSummary[]>([]);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [escrow, setEscrow] = useState<{ available: boolean; reason: string | null } | null>(null);

  useEffect(() => {
    void listLiveRooms().then((r) => setEscrow(r.ok ? { available: r.data.available, reason: r.data.reason } : { available: false, reason: r.message }));
  }, []);

  useEffect(() => {
    if (!wallet.address) return;
    let live = true;
    void listAllRooms().then((r) => {
      if (!live) return;
      if (r.ok) { setRooms(r.data.rooms); setEscrowRooms(r.data.escrowRooms); setRoomsError(null); } else { setRooms(null); setRoomsError(r.status === 401 ? "Unlock your wallet to see your rooms." : r.message); }
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
      <PageHeader
        title="Rooms"
        description="Raise money or split a cost with a link anyone can pay."
        actions={<Link href="/rooms" className="text-sm font-medium text-primary-ink hover:underline">Live Rooms</Link>}
      />

      <EscrowCreateForm
        symbols={["USDC", "MON"]}
        disabledReason={escrow === null ? "Checking whether escrow Rooms are available…" : !escrow.available ? escrow.reason : !wallet.address ? "Connect or unlock your wallet to create a room." : null}
      />

      <details className="group mt-6 rounded-lg border border-border bg-panel">
        <summary className="cursor-pointer list-none px-5 py-3.5 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          Direct split <span className="font-normal text-muted-foreground">— no escrow, paid straight to the recipient</span>
        </summary>
      <section aria-labelledby="room-new" className="border-t border-border">
        <h2 id="room-new" className="sr-only">New direct split</h2>
        <form onSubmit={onPreview} className="space-y-3 px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Describe the room</span>
            <input
              value={text}
              onChange={(e) => { setText(e.target.value); setPreview(null); }}
              placeholder="A room for 100 USDC for 5 people"
              maxLength={300}
              className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">What it&apos;s for <span className="font-normal">(optional)</span></span>
            <input
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Team dinner"
              maxLength={80}
              className="h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Say the total or each share (&ldquo;20 USDC each&rdquo;), how many people pay, and optionally who receives it
            (&ldquo;to bob.nad&rdquo;) and how long it stays open (&ldquo;in 3 days&rdquo;). It goes to you unless you name someone.
          </p>
          {!preview && (
            <button type="submit" disabled={!text.trim() || busy != null || !wallet.address}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
              {busy === "preview" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null} Preview
            </button>
          )}
          {!wallet.address && <p className="text-sm text-muted-foreground">Connect or unlock your wallet to create a room.</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </form>

        {preview && (
          <div className="border-t border-border px-5 py-4">
            <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Total</dt><dd className="tabular-nums text-foreground">{preview.total} {preview.symbol}</dd>
              <dt className="text-muted-foreground">Each person pays</dt><dd className="tabular-nums text-foreground">{preview.share} {preview.symbol}</dd>
              <dt className="text-muted-foreground">People paying</dt><dd className="text-foreground">{preview.participants}</dd>
              <dt className="text-muted-foreground">Goes to</dt>
              <dd className="break-all text-foreground">{preview.recipient.isCreator ? "You" : preview.recipient.label ?? shortAddr(preview.recipient.address)}{!preview.recipient.isCreator && preview.recipient.label && <span className="ml-1 font-mono text-xs text-muted-foreground">{shortAddr(preview.recipient.address)}</span>}</dd>
              <dt className="text-muted-foreground">Open for</dt><dd className="text-foreground">{preview.expiresInDays} day{preview.expiresInDays === 1 ? "" : "s"}</dd>
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              An open room: participants aren&apos;t identity-verified. Each share goes straight from the person paying to
              the recipient when they pay, with PayAI&apos;s fee added on top for the person paying — PayAI never holds the money, so there&apos;s no escrow and nothing is refunded
              if the room closes early. Creating the room moves no funds.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={onCreate} disabled={busy != null}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
                {busy === "create" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null} Create room
              </button>
              <button type="button" onClick={() => setPreview(null)} disabled={busy != null}
                className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Edit
              </button>
            </div>
          </div>
        )}
      </section>
      </details>

      <section aria-labelledby="rooms-mine" className="mt-8">
        <h2 id="rooms-mine" className="mb-3 text-sm font-semibold text-foreground">Your rooms</h2>
        {roomsError ? (
          <p className="text-sm text-muted-foreground">{roomsError}</p>
        ) : !wallet.address ? (
          <EmptyState compact title="No rooms to show yet" hint="Connect or unlock your wallet to see rooms you started or joined." />
        ) : rooms == null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rooms.length === 0 && escrowRooms.length === 0 ? (
          <EmptyState compact title="No rooms yet." hint="Rooms you create or contribute to appear here." />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {escrowRooms.map((r) => (
              <li key={r.id}>
                <Link href={`/dashboard/rooms/${r.id}`} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm transition-colors hover:bg-input/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">{r.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <StatusIndicator tone={ESCROW_STATUS[r.status].tone} label={ESCROW_STATUS[r.status].label} />
                      <span className="tabular-nums">{r.raised ?? "—"} of {r.target} {r.symbol}</span>
                      <span>· Escrow</span>
                      <span>· {r.role === "creator" ? "You created it" : "You contributed"}</span>
                    </span>
                  </span>
                  <ArrowRight size={14} aria-hidden className="shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
            {rooms.map((r) => (
              <li key={r.id}>
                <Link href={`/dashboard/rooms/${r.id}`} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm transition-colors hover:bg-input/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">{r.memo ?? `Room for ${r.total} ${r.symbol}`}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <StatusIndicator tone={ROOM_STATUS[r.status].tone} label={ROOM_STATUS[r.status].label} />
                      <span className="tabular-nums">{r.paid} of {r.target} paid</span>
                      <span>· {r.share} {r.symbol} each</span>
                      <span>· {r.role === "creator" ? "You created it" : "You joined"}</span>
                    </span>
                  </span>
                  <ArrowRight size={14} aria-hidden className="shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
