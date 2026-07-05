"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  CalendarClock, X, ArrowUpRight, ExternalLink, Repeat, CheckCircle2,
  Plus, Pencil, ShieldCheck, AlertTriangle,
} from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { useWallet } from "@/lib/wallet/useWallet";
import { useToast } from "@/components/Toast";
import { recipientError, isValidRecipient } from "@/lib/validation";

type EndCondition = { type: "never" } | { type: "after_count"; totalRuns: number } | { type: "until_date"; untilMs: number };
interface ScheduleRun { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string }
interface Schedule {
  id: string; amount: number; token: string; recipient: string; domain?: string | null;
  cadence: "once" | "daily" | "weekly" | "monthly"; nextRun: number;
  status: "upcoming" | "completed" | "cancelled" | "failed";
  createdAt: number; runs: ScheduleRun[]; memo?: string;
  endCondition?: EndCondition; runsCompleted: number; failureCount: number; lastError?: string | null;
}

const short = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");
const CADENCE_LABEL: Record<Schedule["cadence"], string> = { once: "One-time", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };
const MAX_CONSECUTIVE_FAILURES = 3;

function whenLabel(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "due now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return days <= 30 ? `in ${days}d` : new Date(ms).toLocaleDateString();
}

function endLabel(s: Schedule): string | null {
  const ec = s.endCondition;
  if (!ec || ec.type === "never") return null;
  if (ec.type === "after_count") return `${s.runsCompleted} of ${ec.totalRuns} payments`;
  return `until ${new Date(ec.untilMs).toLocaleDateString()}`;
}

export default function ScheduledPage() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);

  // Scoped to the connected wallet — on the shared demo tenant, this is what
  // keeps one user's scheduled payments private from every other user.
  const load = useCallback(() => {
    const qs = wallet.address ? `?wallet=${wallet.address}` : "";
    fetch(`/api/schedule${qs}`).then((r) => r.json()).then((j) => setSchedules(j.schedules ?? [])).finally(() => setLoading(false));
  }, [wallet.address]);
  useEffect(() => { load(); }, [load]);

  async function cancel(id: string) {
    setBusy(id);
    try {
      const wallet_qs = wallet.address ? `&wallet=${wallet.address}` : "";
      await fetch(`/api/schedule?id=${id}${wallet_qs}`, { method: "DELETE" });
      toast("Scheduled payment cancelled");
      load();
    } finally {
      setBusy(null);
    }
  }

  const upcoming = schedules.filter((s) => s.status === "upcoming");
  const atRisk = upcoming.filter((s) => s.failureCount > 0);
  const failed = schedules.filter((s) => s.status === "failed");
  const completed = schedules.filter((s) => s.status === "completed");
  const cancelled = schedules.filter((s) => s.status === "cancelled");

  const STATS = [
    { label: "Upcoming", value: upcoming.length, icon: CalendarClock, tone: "text-primary" },
    { label: "Needs attention", value: failed.length + atRisk.length, icon: AlertTriangle, tone: failed.length + atRisk.length > 0 ? "text-danger" : "text-muted-foreground" },
    { label: "Completed", value: completed.length, icon: CheckCircle2, tone: "text-success" },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Scheduled Payments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Recurring and future-dated payments that settle automatically on Monad Mainnet when due.
          </p>
        </div>
        {wallet.address && (
          <Button onClick={() => { setEditing(null); setFormOpen(true); }} className="flex items-center gap-1.5">
            <Plus size={15} /> New scheduled payment
          </Button>
        )}
      </div>

      {/* Honest about how this actually settles — a recurring payment isn't
          signed by the user in real time, so the trust model deserves its own
          plain explanation rather than being left implicit. */}
      <Card className="mb-6 !p-4">
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary"><ShieldCheck size={17} /></span>
          <div>
            <p className="text-sm font-medium text-foreground">How scheduled payments settle</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              You aren&apos;t there to sign each occurrence, so a scheduled payment settles through PayAI&apos;s
              automated agent rather than a live signature from your wallet. That agent is bounded by
              per-transaction and daily spend caps enforced on-chain, and every run is checked against the same
              validation and risk screening as an instant payment. If a run fails or is blocked, it stops and
              tells you — it never silently retries forever or skips a payment without telling you.
            </p>
          </div>
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-3 gap-3">
        {STATS.map((s) => (
          <Card key={s.label} className="!p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><s.icon size={14} className={s.tone} /> {s.label}</div>
            <p className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">{s.value}</p>
          </Card>
        ))}
      </div>

      {!wallet.address ? (
        <Card className="text-center">
          <p className="text-sm font-medium text-foreground">Connect your wallet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">Scheduled payments are private to your wallet. Connect it to create or view yours.</p>
        </Card>
      ) : loading ? (
        <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>
      ) : schedules.length === 0 ? (
        <Card className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <CalendarClock size={22} />
          </div>
          <p className="text-sm font-medium text-foreground">No scheduled payments yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Create one with the button above, or ask PayAI directly. For example:
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {["schedule 10 USDC to a .nad domain every Friday", "pay 5 MON to an address next Monday", "send 2 USDC to a payee monthly"].map((ex) => (
              <code key={ex} className="rounded-md border border-border bg-input px-2.5 py-1 text-xs text-muted-foreground">{ex}</code>
            ))}
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {failed.length > 0 && (
            <Section title="Needs attention">
              {failed.map((s) => <ScheduleRow key={s.id} s={s} />)}
            </Section>
          )}
          {upcoming.length > 0 && (
            <Section title="Upcoming">
              {upcoming.map((s) => (
                <ScheduleRow
                  key={s.id} s={s} busy={busy === s.id}
                  onCancel={() => cancel(s.id)}
                  onEdit={() => { setEditing(s); setFormOpen(true); }}
                />
              ))}
            </Section>
          )}
          {completed.length > 0 && (
            <Section title="Completed">
              {completed.map((s) => <ScheduleRow key={s.id} s={s} />)}
            </Section>
          )}
          {cancelled.length > 0 && (
            <Section title="Cancelled">
              {cancelled.map((s) => <ScheduleRow key={s.id} s={s} />)}
            </Section>
          )}
        </div>
      )}

      <ScheduleForm
        open={formOpen}
        editing={editing}
        walletAddress={wallet.address}
        onClose={() => setFormOpen(false)}
        onSaved={() => { setFormOpen(false); load(); }}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function ScheduleRow({ s, onCancel, onEdit, busy }: { s: Schedule; onCancel?: () => void; onEdit?: () => void; busy?: boolean }) {
  const lastRun = s.runs[0];
  const end = endLabel(s);
  const atRisk = s.status === "upcoming" && s.failureCount > 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}
      className={`rounded-lg border p-4 ${s.status === "failed" ? "border-danger/30 bg-danger/5" : atRisk ? "border-warning/30 bg-warning/5" : "border-border bg-panel"}`}
    >
      <div className="flex items-center gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${s.status === "failed" ? "bg-danger/12 text-danger" : "bg-primary/12 text-primary"}`}>
          {s.status === "failed" ? <AlertTriangle size={18} /> : s.cadence === "once" ? <ArrowUpRight size={18} /> : <Repeat size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1"><TokenLogo token={s.token} size={14} /></span>
            <p className="text-sm font-semibold text-foreground [font-variant-numeric:tabular-nums]">{s.amount} {s.token}</p>
            <span className="text-muted-foreground">→</span>
            <p className="truncate font-mono text-xs text-foreground">{s.domain ?? short(s.recipient)}</p>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {CADENCE_LABEL[s.cadence]}
            {s.status === "upcoming" && <> · next {whenLabel(s.nextRun)} ({new Date(s.nextRun).toLocaleString()})</>}
            {end && <> · {end}</>}
            {s.runs.length > 0 && <> · {s.runs.length} run{s.runs.length === 1 ? "" : "s"}</>}
          </p>
          {atRisk && (
            <p className="mt-1 text-xs text-warning">
              {s.failureCount} failed attempt{s.failureCount === 1 ? "" : "s"} — will pause after {MAX_CONSECUTIVE_FAILURES - s.failureCount} more.
            </p>
          )}
          {s.status === "failed" && s.lastError && (
            <p className="mt-1 text-xs text-danger">Stopped: {s.lastError}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={s.status === "upcoming" ? "primary" : s.status === "completed" ? "success" : s.status === "failed" ? "danger" : "neutral"}>{s.status}</Badge>
          {onEdit && (
            <Button variant="secondary" className="!px-2 !py-1.5 text-xs" onClick={onEdit} title="Edit schedule">
              <Pencil size={13} />
            </Button>
          )}
          {onCancel && (
            <Button variant="secondary" className="!px-2 !py-1.5 text-xs" onClick={onCancel} disabled={busy} title="Cancel schedule">
              <X size={13} />
            </Button>
          )}
        </div>
      </div>
      {lastRun?.explorerUrl && (
        <a href={lastRun.explorerUrl} target="_blank" rel="noreferrer" className="mt-2.5 inline-flex items-center gap-1.5 border-t border-border pt-2.5 font-mono text-xs text-primary hover:underline">
          Last run: {short(lastRun.txHash)} <ExternalLink size={11} />
        </a>
      )}
    </motion.div>
  );
}

/** to a <input type="datetime-local"> string, in the browser's local time. */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ScheduleForm({
  open, editing, walletAddress, onClose, onSaved,
}: { open: boolean; editing: Schedule | null; walletAddress: string | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"MON" | "USDC">("MON");
  const [recipient, setRecipient] = useState("");
  const [cadence, setCadence] = useState<Schedule["cadence"]>("weekly");
  const [startAt, setStartAt] = useState(() => toLocalInputValue(Date.now() + 60 * 60 * 1000));
  const [endType, setEndType] = useState<"never" | "after_count" | "until_date">("after_count");
  const [totalRuns, setTotalRuns] = useState("4");
  const [untilDate, setUntilDate] = useState(() => toLocalInputValue(Date.now() + 90 * 24 * 60 * 60 * 1000));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setAmount(String(editing.amount));
      setToken(editing.token as "MON" | "USDC");
      setRecipient(editing.domain ?? editing.recipient);
      setCadence(editing.cadence);
      setStartAt(toLocalInputValue(editing.nextRun));
      const ec = editing.endCondition;
      if (ec?.type === "after_count") { setEndType("after_count"); setTotalRuns(String(ec.totalRuns)); }
      else if (ec?.type === "until_date") { setEndType("until_date"); setUntilDate(toLocalInputValue(ec.untilMs)); }
      else setEndType("never");
    } else {
      setAmount(""); setToken("MON"); setRecipient(""); setCadence("weekly");
      setStartAt(toLocalInputValue(Date.now() + 60 * 60 * 1000));
      setEndType("after_count"); setTotalRuns("4");
    }
    setErr(null);
  }, [open, editing]);

  const recipientErr = recipient ? recipientError(recipient) : null;
  const canSubmit = Number(amount) > 0 && isValidRecipient(recipient) && !saving;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    const startMs = new Date(startAt).getTime();
    const endCondition =
      endType === "never" ? { type: "never" as const }
        : endType === "after_count" ? { type: "after_count" as const, totalRuns: Math.max(1, Math.floor(Number(totalRuns) || 1)) }
          : { type: "until_date" as const, untilMs: new Date(untilDate).getTime() };
    try {
      if (editing) {
        const r = await fetch(`/api/schedule?id=${editing.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ walletAddress, amount: Number(amount), cadence, nextRun: startMs, endCondition }),
        });
        const j = await r.json();
        if (!j.success) throw new Error(j.error || "Couldn't save the changes.");
        toast("Scheduled payment updated");
      } else {
        const r = await fetch("/api/schedule", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ walletAddress, amount: Number(amount), token, recipient, cadence, startAt: startMs, endCondition }),
        });
        const j = await r.json();
        if (!j.success) throw new Error(j.error || "Couldn't create the schedule.");
        toast("Scheduled payment created");
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 px-4 sm:backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-panel shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <p className="text-sm font-semibold text-foreground">{editing ? "Edit scheduled payment" : "New scheduled payment"}</p>
              <button onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground transition hover:bg-input hover:text-foreground"><X size={16} /></button>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">Amount</label>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-input px-3 py-2.5">
                  <input
                    value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                    inputMode="decimal" placeholder="0.00"
                    className="w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/50"
                  />
                  <div className="flex shrink-0 gap-1 rounded-full border border-border bg-panel p-1">
                    {(["MON", "USDC"] as const).map((t) => (
                      <button
                        key={t} onClick={() => setToken(t)} disabled={!!editing}
                        className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${token === t ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      >
                        <TokenLogo token={t} size={13} /> {t}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {!editing && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">To</label>
                  <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="alex.nads or 0x…" className="w-full" />
                  {recipientErr && <p className="mt-1 text-xs text-danger">{recipientErr}</p>}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">Repeats</label>
                  <select
                    value={cadence} onChange={(e) => setCadence(e.target.value as Schedule["cadence"])}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground outline-none"
                  >
                    <option value="once">Once</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {cadence === "once" ? "When" : "Starts"}
                  </label>
                  <input
                    type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground outline-none"
                  />
                </div>
              </div>

              {cadence !== "once" && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground">Ends</label>
                  <div className="space-y-2 rounded-lg border border-border p-3">
                    {[
                      { v: "after_count" as const, label: "After a number of payments" },
                      { v: "until_date" as const, label: "On a specific date" },
                      { v: "never" as const, label: "Never (not recommended)" },
                    ].map((opt) => (
                      <label key={opt.v} className="flex items-center gap-2 text-sm text-foreground">
                        <input type="radio" checked={endType === opt.v} onChange={() => setEndType(opt.v)} className="accent-primary" />
                        {opt.label}
                      </label>
                    ))}
                    {endType === "after_count" && (
                      <input
                        value={totalRuns} onChange={(e) => setTotalRuns(e.target.value.replace(/[^0-9]/g, ""))}
                        inputMode="numeric" placeholder="4"
                        className="mt-1 w-24 rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground outline-none"
                      />
                    )}
                    {endType === "until_date" && (
                      <input
                        type="datetime-local" value={untilDate} onChange={(e) => setUntilDate(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground outline-none"
                      />
                    )}
                  </div>
                </div>
              )}

              {err && <p className="text-xs text-danger">{err}</p>}

              <Button onClick={submit} disabled={!canSubmit} className="w-full py-2.5">
                {saving ? "Saving…" : editing ? "Save changes" : "Create scheduled payment"}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
