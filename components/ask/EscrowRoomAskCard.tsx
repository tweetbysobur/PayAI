"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { StatusIndicator } from "@/components/dashboard/primitives";
import { PlanCard } from "@/components/ask/PlanCard";
import { primePlan, type PlanCardData } from "@/lib/ask/planCards";
import { confirmEscrowAction, getEscrowRoom, startEscrowAction, type EscrowRoomView } from "@/lib/rooms/client";
import { ESCROW_STATUS, timeLeft } from "@/components/rooms/escrow/format";
import { feePercent } from "@/lib/rooms/escrowChain";
import { usePlanSettled } from "@/components/rooms/escrow/usePlanSettled";

/**
 * An escrow room in Ask PayAI's chat — the same escrow Rooms API, contract
 * reads and verification as the room page (/r/{id}). Ask never supplies an
 * amount: a fixed-share room's share comes from its on-chain terms, and a
 * target room's amount is what the person types here. Contributing is the
 * existing plan card; the room counts it only after the server verifies the
 * escrow's own event. Claims, refunds and cancelling happen on the room page.
 */
export function EscrowRoomAskCard({ id, action }: { id: string; action: "status" | "join" | "contribute" }) {
  const [room, setRoom] = useState<EscrowRoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await getEscrowRoom(id);
    if (r.ok) { setRoom(r.data); setPlanId((p) => p ?? r.data.viewer.pending.contribute ?? null); } else setError(r.status === 404 ? "That room doesn't exist." : r.message);
  }, [id]);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  usePlanSettled(planId, () => {
    void confirmEscrowAction(id, "contribute").then((r) => {
      if (r.ok) { setRoom(r.data); setPlanId(null); setNotice("Your contribution is confirmed and held in escrow."); }
      else if (r.code !== "NOT_SETTLED") setNotice(r.message);
    });
  });

  if (error) return <Shell><p role="alert" className="text-foreground">{error}</p></Shell>;
  if (!room) return <Shell><p className="flex items-center gap-2 text-muted-foreground"><Loader2 size={14} className="animate-spin" aria-hidden /> Checking the escrow…</p></Shell>;

  const sym = room.asset.symbol;
  const s = ESCROW_STATUS[room.chain?.status ?? (room.live ? "open" : "pending")];
  const v = room.viewer;

  async function contribute() {
    if (busy) return;
    setBusy(true); setNotice(null);
    const r = await startEscrowAction(id, "contribute", room!.kind === "target" ? amount.trim() : undefined);
    setBusy(false);
    if (!r.ok) { setNotice(r.message); return; }
    primePlan({ plan: r.data.plan, review: r.data.review } as PlanCardData);
    setPlanId(r.data.planId);
  }

  return (
    <div className="space-y-3">
      <Shell>
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 truncate font-medium text-foreground">{room.title}</p>
          <StatusIndicator tone={s.tone} label={s.label} />
        </div>
        <dl className="mt-2 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">Raised</dt><dd className="tabular-nums text-foreground">{room.chain ? `${room.chain.raised} of ${room.target} ${sym}` : "—"}</dd>
          <dt className="text-muted-foreground">Contributors</dt><dd className="tabular-nums text-foreground">{room.chain ? room.chain.contributors : "—"}</dd>
          <dt className="text-muted-foreground">Deadline</dt><dd className="text-foreground">{timeLeft(room.deadline, Date.now())}</dd>
          <dt className="text-muted-foreground">Held by</dt><dd className="text-foreground">Room escrow contract</dd>
          {v.contributed && v.contributed !== "0" && <><dt className="text-muted-foreground">You put in</dt><dd className="tabular-nums text-foreground">{v.contributed} {sym}</dd></>}
        </dl>
        {room.unavailable && <p className="mt-3 text-muted-foreground">{room.unavailable}</p>}
        {action === "join" && <p className="mt-3 text-muted-foreground">Escrow rooms don&apos;t need joining — anyone with the link can contribute.</p>}
        {(action === "contribute" || action === "join") && !planId && (v.canContribute ? (
          <div className="mt-3">
            {room.kind === "fixed" ? (
              <p className="text-muted-foreground">Your share is {room.share} {sym}, held in escrow until the room completes; refundable if it doesn&apos;t. You pay exactly the share; PayAI deducts its {feePercent(room.feeBps)} platform fee from successful proceeds only.</p>
            ) : (
              <label className="block text-muted-foreground">Amount ({sym}) — up to {room.chain?.remaining ?? "—"}{room.minContribution ? `; at least ${room.minContribution} unless it's exactly the amount still needed` : ""}
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={room.minContribution ?? "0"}
                  className="mt-1.5 h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              </label>
            )}
            <button type="button" onClick={contribute} disabled={busy || (room.kind === "target" && !amount.trim())}
              className="mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden />} Review contribution
            </button>
          </div>
        ) : action === "contribute" ? (
          <p className="mt-3 text-muted-foreground">{room.chain?.status && room.chain.status !== "open" ? `This room is ${room.chain.status}; it isn't taking contributions.` : !room.live ? "This room isn't live yet." : v.signedIn ? "You can't contribute to this room right now." : "Unlock your wallet to contribute."}</p>
        ) : null)}
        {notice && <p role="status" className="mt-3 flex items-center gap-1.5 text-foreground"><Check size={13} aria-hidden className="text-primary-ink" />{notice}</p>}
        <Link href={`/r/${room.id}`} className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-ink hover:underline">
          Open room <ArrowRight size={13} aria-hidden />
        </Link>
      </Shell>
      {planId && <PlanCard planRef={{ planId, kind: "transfer" }} />}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-border bg-panel px-4 py-3.5 text-sm">{children}</div>;
}
