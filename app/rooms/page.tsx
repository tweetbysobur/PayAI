"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listLiveRooms, type PublicRoomCard } from "@/lib/rooms/client";
import { StatusIndicator } from "@/components/dashboard/primitives";
import { ESCROW_STATUS, pct, timeLeft } from "@/components/rooms/escrow/format";

/**
 * Live Rooms — escrow rooms whose creators chose to list them publicly.
 * Progress, contributor counts and status come from the escrow contract (via
 * the server); nothing is invented. Private rooms never appear.
 */
export default function LiveRoomsPage() {
  const [state, setState] = useState<{ loading: true } | { loading: false; error: string | null; available: boolean; reason: string | null; rooms: PublicRoomCard[] }>({ loading: true });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void listLiveRooms().then((r) => {
      if (!alive) return;
      setNow(Date.now());
      setState(r.ok ? { loading: false, error: null, ...r.data } : { loading: false, error: r.message, available: true, reason: null, rooms: [] });
    });
    return () => { alive = false; };
  }, []);

  const open = state.loading ? [] : state.rooms.filter((r) => r.status === "open");
  const closed = state.loading ? [] : state.rooms.filter((r) => r.status !== "open");

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Live Rooms</h1>
      <p className="mt-1.5 text-pretty text-sm text-muted-foreground">Public fundraisers and group payments. Every contribution is held by the Room escrow contract until the room completes — or refunded if it doesn&apos;t.</p>

      <div className="mt-6">
        {state.loading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading rooms">{[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-panel" />)}</div>
        ) : state.error ? (
          <p role="alert" className="rounded-lg border border-danger/30 bg-danger/[0.06] px-4 py-3 text-sm text-foreground">{state.error}</p>
        ) : !state.available ? (
          <p className="rounded-2xl border border-border bg-panel p-5 text-sm text-muted-foreground">{state.reason}</p>
        ) : state.rooms.length === 0 ? (
          <div className="rounded-2xl border border-border bg-panel p-6 text-center">
            <p className="text-sm font-medium text-foreground">No public rooms right now</p>
            <p className="mt-1 text-sm text-muted-foreground">Rooms appear here only when their creators choose to list them.</p>
            <Link href="/dashboard/rooms" className="mt-3 inline-flex text-sm font-medium text-primary-ink hover:underline">Start a room</Link>
          </div>
        ) : (
          <>
            <ul className="space-y-3">{open.map((r) => <Card key={r.id} r={r} now={now} />)}</ul>
            {open.length === 0 && <p className="text-sm text-muted-foreground">No public room is collecting right now.</p>}
            {closed.length > 0 && (
              <>
                <h2 className="mb-3 mt-8 text-sm font-semibold text-foreground">Recently closed</h2>
                <ul className="space-y-3">{closed.map((r) => <Card key={r.id} r={r} now={now} />)}</ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Card({ r, now }: { r: PublicRoomCard; now: number }) {
  const s = ESCROW_STATUS[r.status];
  return (
    <li>
      <Link href={`/r/${r.id}`} className="block rounded-2xl border border-border bg-panel p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-balance font-medium text-foreground">{r.title}</p>
          <StatusIndicator tone={s.tone} label={s.label} className="shrink-0" />
        </div>
        <p className="mt-2 text-sm text-foreground [font-variant-numeric:tabular-nums]">{r.raised} <span className="text-muted-foreground">of {r.target} {r.symbol}</span></p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-input" aria-hidden><div className="h-full rounded-full bg-primary" style={{ width: pct(r.progressBps) }} /></div>
        <p className="mt-2 text-xs text-muted-foreground">{r.contributors} contributor{r.contributors === 1 ? "" : "s"} · {r.status === "open" ? timeLeft(r.deadline, now) : "Closed"}</p>
      </Link>
    </li>
  );
}
