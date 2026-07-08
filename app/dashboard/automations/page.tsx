"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  AlertTriangle, ArrowRight, BarChart3, CalendarClock, CheckCircle2, Copy, ExternalLink,
  MoreHorizontal, Pause, Play, Plus, ReceiptText, Repeat, ShieldCheck, Trash2, X,
} from "lucide-react";
import { Badge, Button, Card, Input } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { useToast } from "@/components/Toast";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";

type Cadence = "once" | "daily" | "weekly" | "monthly" | "custom";
type Status = "active" | "paused" | "completed" | "cancelled" | "failed" | "scheduled" | "executing";
type IntervalUnit = "days" | "weeks" | "months";
type Run = { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string; gasFee?: number };
type Automation = {
  id: string; amount: number; token: "MON" | "USDC" | string; recipient: string; domain?: string | null;
  cadence: Cadence; intervalCount?: number; intervalUnit?: IntervalUnit; nextRun: number; status: Status;
  createdAt: number; runs: Run[]; purpose?: string; memo?: string; timezone?: string; runsCompleted: number; failureCount: number; lastError?: string | null; sender?: string | null;
};

const PURPOSES = ["Savings", "Salary", "Subscription", "Investment", "Rent", "Family", "Utilities", "Gift", "Business", "Other"];
const STATUS_TONE: Record<Status, "neutral" | "success" | "warning" | "danger" | "primary"> = {
  active: "success", scheduled: "primary", executing: "warning", paused: "neutral", completed: "success", cancelled: "neutral", failed: "danger",
};
const short = (s?: string | null) => (s ? `${s.slice(0, 6)}...${s.slice(-4)}` : "-");
const money = (n: number, token = "") => `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}${token ? ` ${token}` : ""}`;

function cadenceLabel(a: Pick<Automation, "cadence" | "intervalCount" | "intervalUnit">) {
  if (a.cadence === "once") return "One time";
  if (a.cadence === "daily") return "Daily";
  if (a.cadence === "weekly") return "Weekly";
  if (a.cadence === "monthly") return "Monthly";
  return `Every ${a.intervalCount ?? 1} ${a.intervalUnit ?? "days"}`;
}

function annualVolume(a: Automation) {
  const amount = Number(a.amount) || 0;
  if (a.cadence === "once") return amount;
  if (a.cadence === "daily") return amount * 365;
  if (a.cadence === "weekly") return amount * 52;
  if (a.cadence === "monthly") return amount * 12;
  const count = Math.max(1, a.intervalCount ?? 1);
  if (a.intervalUnit === "weeks") return amount * (52 / count);
  if (a.intervalUnit === "months") return amount * (12 / count);
  return amount * (365 / count);
}

function signatureMessage(input: { walletAddress: string; recipient: string; amount: number; token: string; cadence: string; startAt: number; timezone: string; purpose: string }) {
  return [
    "PayAI Payment Automation",
    `Wallet: ${input.walletAddress}`,
    `Recipient: ${input.recipient}`,
    `Amount: ${input.amount} ${input.token}`,
    `Automation: ${input.cadence}`,
    `First execution: ${new Date(input.startAt).toISOString()}`,
    `Timezone: ${input.timezone}`,
    `Purpose: ${input.purpose}`,
    "Network: Monad Mainnet",
  ].join("\n");
}

export default function AutomationsPage() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    const qs = wallet.address ? `?wallet=${wallet.address}` : "";
    fetch(`/api/automations${qs}`)
      .then((r) => r.json())
      .then((j) => setAutomations(j.automations ?? []))
      .finally(() => setLoading(false));
  }, [wallet.address]);

  useEffect(() => { load(); }, [load]);

  async function action(id: string, actionName: "pause" | "resume" | "cancel" | "delete") {
    setBusy(id);
    try {
      const walletParam = wallet.address ? `?id=${id}&wallet=${wallet.address}` : `?id=${id}`;
      const r = actionName === "delete"
        ? await fetch(`/api/automations${walletParam}`, { method: "DELETE" })
        : await fetch(`/api/automations?id=${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ walletAddress: wallet.address, action: actionName }) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "Action failed.");
      toast(actionName === "resume" ? "Automation resumed" : `Automation ${actionName}d`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Automation action failed");
    } finally {
      setBusy(null);
    }
  }

  const active = automations.filter((a) => a.status === "active" || a.status === "scheduled" || a.status === "executing");
  const upcoming = active.slice().sort((a, b) => a.nextRun - b.nextRun).slice(0, 5);
  const runs = automations.flatMap((a) => a.runs.map((run) => ({ ...run, automation: a }))).sort((a, b) => b.at - a.at);
  const totalVolume = automations.reduce((sum, a) => sum + a.runs.filter((r) => r.decision === "executed").length * a.amount, 0);
  const totalRuns = runs.length;
  const successRuns = runs.filter((r) => r.decision === "executed").length;
  const successRate = totalRuns ? Math.round((successRuns / totalRuns) * 100) : 0;
  const totalGas = runs.reduce((sum, r) => sum + (r.gasFee ?? 0), 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Payment Automations</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Create reliable MON and USDC automations with wallet confirmation, verified recipients, and execution history on Monad Mainnet.
          </p>
        </div>
        {wallet.address && (
          <Button onClick={() => setCreatorOpen(true)} className="inline-flex items-center gap-2">
            <Plus size={16} /> Create Automation
          </Button>
        )}
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="Active Automations" value={active.length.toString()} icon={Repeat} />
        <Metric title="Success Rate" value={`${successRate}%`} icon={ShieldCheck} />
        <Metric title="Total Volume" value={money(totalVolume)} icon={BarChart3} />
        <Metric title="Gas Spent" value={`${totalGas.toFixed(4)} MON`} icon={ReceiptText} />
      </section>

      {!wallet.address ? (
        <Card className="text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary"><ShieldCheck size={20} /></div>
          <p className="text-sm font-medium text-foreground">Connect your wallet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">Automations are scoped to your wallet. Connect to create and manage yours.</p>
        </Card>
      ) : loading ? (
        <Card><p className="text-sm text-muted-foreground">Loading automations...</p></Card>
      ) : (
        <>
          <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
            <Card title="Active Automations" right={<span className="text-xs text-muted-foreground">{active.length} live</span>}>
              {active.length === 0 ? <EmptyState title="No active automations" detail="Create an automation when you want PayAI to execute a payment on a future cadence." /> : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {active.map((a) => <AutomationCard key={a.id} automation={a} busy={busy === a.id} onAction={action} onDuplicate={() => setCreatorOpen(true)} />)}
                </div>
              )}
            </Card>
            <Card title="Upcoming Executions">
              <Timeline items={upcoming.map((a) => ({ id: a.id, title: `${a.purpose ?? "Automation"} - ${money(a.amount, a.token)}`, detail: `${new Date(a.nextRun).toLocaleString()} - ${a.timezone ?? "Africa/Lagos"}`, status: a.status, href: null }))} empty="No upcoming executions." />
            </Card>
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card title="Recent Activity">
              <Timeline items={runs.slice(0, 5).map((r) => ({ id: `${r.automation.id}-${r.at}`, title: `${r.automation.purpose ?? "Automation"} ${r.decision === "executed" ? "executed" : r.decision}`, detail: new Date(r.at).toLocaleString(), status: r.decision === "executed" ? "completed" : "failed", href: r.explorerUrl ?? null }))} empty="No automation activity yet." />
            </Card>
            <Card title="Execution History" className="xl:col-span-2">
              <div className="space-y-3">
                {automations.length === 0 ? <EmptyState title="No automations yet" detail="Your execution timelines will appear here after you create one." /> : automations.map((a) => <ExecutionHistory key={a.id} automation={a} />)}
              </div>
            </Card>
          </section>

          <Card title="Analytics">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <AnalyticsTile label="Total Executions" value={totalRuns.toString()} />
              <AnalyticsTile label="Total Gas Spent" value={`${totalGas.toFixed(4)} MON`} />
              <AnalyticsTile label="Average Gas" value={`${(totalRuns ? totalGas / totalRuns : 0).toFixed(4)} MON`} />
              <AnalyticsTile label="Completion" value={`${automations.length ? Math.round((automations.filter((a) => a.status === "completed").length / automations.length) * 100) : 0}%`} />
            </div>
          </Card>
        </>
      )}

      <AutomationCreator open={creatorOpen} onClose={() => setCreatorOpen(false)} onCreated={() => { setCreatorOpen(false); load(); }} />
    </div>
  );
}

function Metric({ title, value, icon: Icon }: { title: string; value: string; icon: typeof Repeat }) {
  return <Card className="!p-4"><div className="flex items-center justify-between"><p className="text-xs text-muted-foreground">{title}</p><Icon size={16} className="text-primary" /></div><p className="mt-2 text-2xl font-semibold text-foreground">{value}</p></Card>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-lg border border-dashed border-border p-6 text-center"><p className="text-sm font-medium text-foreground">{title}</p><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{detail}</p></div>;
}

function Timeline({ items, empty }: { items: { id: string; title: string; detail: string; status: string; href: string | null }[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <div className="space-y-3">{items.map((item) => <div key={item.id} className="flex gap-3"><span className="mt-1 h-2.5 w-2.5 rounded-full bg-primary" /><div className="min-w-0 flex-1 border-b border-border pb-3 last:border-b-0"><div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-medium text-foreground">{item.title}</p>{item.href && <a href={item.href} target="_blank" rel="noreferrer" className="text-primary"><ExternalLink size={13} /></a>}</div><p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p></div></div>)}</div>;
}

function AutomationCard({ automation, busy, onAction, onDuplicate }: { automation: Automation; busy: boolean; onAction: (id: string, action: "pause" | "resume" | "cancel" | "delete") => void; onDuplicate: () => void }) {
  return (
    <motion.div className="rounded-lg border border-border bg-background/35 p-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-foreground">{automation.purpose ?? automation.memo ?? "Automation"}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1"><TokenLogo token={automation.token} size={14} /> {money(automation.amount, automation.token)}</span>
            <span>{cadenceLabel(automation)}</span>
          </div>
        </div>
        <Badge tone={STATUS_TONE[automation.status]}>{automation.status}</Badge>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <Info label="Recipient" value={automation.domain ?? short(automation.recipient)} mono />
        <Info label="Next Execution" value={new Date(automation.nextRun).toLocaleDateString()} />
        <Info label="Time" value={new Date(automation.nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} />
        <Info label="Network" value="Monad Mainnet" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" disabled={busy}>View</Button>
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" disabled={busy}>Edit</Button>
        {automation.status === "paused" ? (
          <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => onAction(automation.id, "resume")} disabled={busy}><Play size={13} /> Resume</Button>
        ) : (
          <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => onAction(automation.id, "pause")} disabled={busy}><Pause size={13} /> Pause</Button>
        )}
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={onDuplicate} disabled={busy}><Copy size={13} /> Duplicate</Button>
        <Button variant="secondary" className="!px-2.5 !py-1.5 text-xs" onClick={() => onAction(automation.id, "cancel")} disabled={busy}><X size={13} /> Cancel</Button>
        <Button variant="ghost" className="!px-2.5 !py-1.5 text-xs text-danger" onClick={() => onAction(automation.id, "delete")} disabled={busy}><Trash2 size={13} /> Delete</Button>
      </div>
    </motion.div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div><p className="text-muted-foreground">{label}</p><p className={`mt-0.5 truncate text-foreground ${mono ? "font-mono" : ""}`}>{value}</p></div>;
}

function AnalyticsTile({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-background/35 p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1.5 text-lg font-semibold text-foreground">{value}</p></div>;
}

function ExecutionHistory({ automation }: { automation: Automation }) {
  const [open, setOpen] = useState(false);
  const synthetic = automation.runs.length ? automation.runs : [{ at: automation.nextRun, decision: "scheduled" }];
  return (
    <div className="rounded-lg border border-border p-4">
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((v) => !v)}>
        <div><p className="text-sm font-medium text-foreground">{automation.purpose ?? "Automation"}</p><p className="mt-0.5 text-xs text-muted-foreground">{money(automation.amount, automation.token)} - {cadenceLabel(automation)}</p></div>
        <MoreHorizontal size={16} className="text-muted-foreground" />
      </button>
      {open && <div className="mt-4 space-y-3">{synthetic.slice(0, 6).map((run, idx) => <div key={`${run.at}-${idx}`} className="flex gap-3 text-sm"><span className={`mt-1 h-2.5 w-2.5 rounded-full ${run.decision === "executed" ? "bg-success" : run.decision === "scheduled" ? "bg-primary" : "bg-danger"}`} /><div><p className="font-medium text-foreground">{new Date(run.at).toLocaleDateString()} - {run.decision === "executed" ? "Executed Successfully" : run.decision === "scheduled" ? "Scheduled" : "Execution Failed"}</p><p className="text-xs text-muted-foreground">{new Date(run.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{run.gasFee ? ` - Gas ${run.gasFee} MON` : ""}</p>{run.explorerUrl && <a href={run.explorerUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary">Explorer Link <ExternalLink size={11} /></a>}</div></div>)}</div>}
    </div>
  );
}

function AutomationCreator({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const wallet = useWallet();
  const balances = useWalletBalances(wallet.address);
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [recipientInput, setRecipientInput] = useState("");
  const [resolved, setResolved] = useState<{ recipient: string; domain: string | null } | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [asset, setAsset] = useState<"MON" | "USDC">("MON");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [intervalCount, setIntervalCount] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("weeks");
  const [date, setDate] = useState(() => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [time, setTime] = useState("10:00");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos");
  const [purpose, setPurpose] = useState("Savings");
  const [customPurpose, setCustomPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const startAt = useMemo(() => new Date(`${date}T${time}:00`).getTime(), [date, time]);
  const amountNum = Number(amount);
  const balance = asset === "MON" ? balances.mon : balances.usdc;
  const balanceNum = balance == null ? null : Number(balance);
  const invalidAmount = !Number.isFinite(amountNum) || amountNum <= 0 || (balanceNum != null && amountNum > balanceNum);
  const finalPurpose = purpose === "Other" ? customPurpose.trim() : purpose;
  const estimateGas = asset === "MON" ? "0.002 MON" : "0.004 MON";

  useEffect(() => {
    if (!open) return;
    setStep(1); setRecipientInput(""); setResolved(null); setRecipientError(null); setAmount(""); setPurpose("Savings"); setCustomPurpose("");
  }, [open]);

  useEffect(() => {
    if (!recipientInput.trim()) { setResolved(null); setRecipientError(null); return; }
    const handle = setTimeout(() => {
      fetch(`/api/automations?resolve=${encodeURIComponent(recipientInput.trim())}`)
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (!ok || !j.success) { setResolved(null); setRecipientError(j.error ?? "Recipient could not be verified."); return; }
          setResolved({ recipient: j.recipient, domain: j.domain }); setRecipientError(null);
        })
        .catch(() => { setResolved(null); setRecipientError("Recipient verification failed."); });
    }, 350);
    return () => clearTimeout(handle);
  }, [recipientInput]);

  async function create() {
    if (!wallet.address || !resolved || invalidAmount || !finalPurpose) return;
    setSaving(true);
    try {
      if (wallet.isWrongNetwork) await wallet.switchNetwork();
      const message = signatureMessage({ walletAddress: wallet.address, recipient: resolved.recipient, amount: amountNum, token: asset, cadence, startAt, timezone, purpose: finalPurpose });
      const signature = await window.ethereum?.request({ method: "personal_sign", params: [message, wallet.address] }) as string | undefined;
      if (!signature) throw new Error("Wallet confirmation was cancelled.");
      const r = await fetch("/api/automations", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.address, recipient: recipientInput, amount: amountNum, token: asset, cadence, intervalCount: Number(intervalCount), intervalUnit, startAt, timezone, purpose: finalPurpose, signature, signatureMessage: message }),
      });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "Could not create automation.");
      toast("Automation created");
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Automation creation failed");
    } finally {
      setSaving(false);
    }
  }

  const canNext = step === 1 ? !!resolved : step === 2 ? !invalidAmount : step === 3 ? cadence !== "custom" || Number(intervalCount) > 0 : step === 4 ? Number.isFinite(startAt) && startAt > Date.now() - 60_000 : step === 5 ? !!finalPurpose : true;

  return (
    <AnimatePresence>
      {open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><p className="text-sm font-semibold text-foreground">Create Payment Automation</p><p className="text-xs text-muted-foreground">Step {step} of 6</p></div><button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-input"><X size={17} /></button></div>
          <div className="grid gap-5 p-5 lg:grid-cols-[180px_1fr]">
            <div className="space-y-2">{["Recipient", "Payment", "Automation", "Execution Time", "Purpose", "Review"].map((label, i) => <button key={label} onClick={() => setStep(i + 1)} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${step === i + 1 ? "bg-primary/15 text-primary" : i + 1 < step ? "text-foreground" : "text-muted-foreground"}`}>{i + 1 < step ? <CheckCircle2 size={14} /> : <span className="h-3.5 w-3.5 rounded-full border border-current" />} {label}</button>)}</div>
            <div className="min-h-[420px]">
              {step === 1 && <Step title="Recipient" detail="Enter a wallet address or .nads domain. PayAI verifies it before you continue."><Input value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} placeholder="alex.nads or 0x..." className="w-full" />{resolved && <Verified label={resolved.domain ?? "Wallet address"} value={resolved.recipient} />}{recipientError && <p className="mt-2 text-sm text-danger">{recipientError}</p>}</Step>}
              {step === 2 && <Step title="Payment" detail="Choose asset and amount. Balance and gas are shown before review."><div className="flex gap-2">{(["MON", "USDC"] as const).map((t) => <button key={t} onClick={() => setAsset(t)} className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm ${asset === t ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground"}`}><TokenLogo token={t} size={16} /> {t}</button>)}</div><Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" inputMode="decimal" className="mt-4 w-full" /><div className="mt-3 grid gap-2 sm:grid-cols-2"><Info label="Wallet Balance" value={balances.loading ? "Loading..." : balance ? money(Number(balance), asset) : "-"} /><Info label="Estimated Gas" value={estimateGas} /></div>{invalidAmount && amount && <p className="mt-2 text-sm text-danger">Enter a valid amount within your wallet balance.</p>}</Step>}
              {step === 3 && <Step title="Automation" detail="Choose the cadence. Custom stays simple in v1: every X days, weeks, or months."><div className="grid gap-2 sm:grid-cols-3">{(["once", "daily", "weekly", "monthly", "custom"] as Cadence[]).map((c) => <button key={c} onClick={() => setCadence(c)} className={`rounded-md border px-3 py-3 text-left text-sm capitalize ${cadence === c ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground"}`}>{c === "once" ? "One Time" : c}</button>)}</div>{cadence === "custom" && <div className="mt-4 flex items-center gap-2"><span className="text-sm text-muted-foreground">Every</span><Input value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-20" /><select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)} className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground"><option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option></select></div>}</Step>}
              {step === 4 && <Step title="Execution Time" detail="Set the first execution date, time, and timezone."><div className="grid gap-3 sm:grid-cols-3"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div><div className="mt-4 rounded-lg border border-border bg-background/35 p-4"><p className="text-sm font-medium text-foreground">{new Date(startAt).toLocaleDateString(undefined, { weekday: "long" })}</p><p className="mt-1 text-sm text-muted-foreground">{time} - {timezone} - Monad Mainnet</p></div></Step>}
              {step === 5 && <Step title="Purpose" detail="Purpose powers history, analytics, receipts, and future AI insights."><div className="grid gap-2 sm:grid-cols-3">{PURPOSES.map((p) => <button key={p} onClick={() => setPurpose(p)} className={`rounded-md border px-3 py-2 text-sm ${purpose === p ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground"}`}>{p}</button>)}</div>{purpose === "Other" && <Input value={customPurpose} onChange={(e) => setCustomPurpose(e.target.value)} placeholder="Custom purpose" className="mt-4 w-full" />}</Step>}
              {step === 6 && <Step title="Review" detail="Verify every field. Your wallet signs once before the automation becomes active."><div className="grid gap-3 sm:grid-cols-2"><Info label="Recipient" value={recipientInput} /><Info label="Resolved Address" value={resolved?.recipient ?? "-"} mono /><Info label="Asset" value={asset} /><Info label="Amount" value={money(amountNum || 0, asset)} /><Info label="Automation Type" value={cadence === "custom" ? `Every ${intervalCount} ${intervalUnit}` : cadenceLabel({ cadence })} /><Info label="Execution Time" value={new Date(startAt).toLocaleString()} /><Info label="Timezone" value={timezone} /><Info label="Purpose" value={finalPurpose || "-"} /><Info label="Estimated Annual Volume" value={money(annualVolume({ amount: amountNum || 0, token: asset, cadence, intervalCount: Number(intervalCount), intervalUnit } as Automation), asset)} /><Info label="Estimated Gas" value={estimateGas} /><Info label="Network" value="Monad Mainnet" /><Info label="Wallet" value={short(wallet.address)} mono /><Info label="Status" value="Active after signature" /></div></Step>}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border px-5 py-4"><Button variant="secondary" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1}>Back</Button>{step < 6 ? <Button onClick={() => setStep((s) => Math.min(6, s + 1))} disabled={!canNext}>Continue <ArrowRight size={14} /></Button> : <Button onClick={create} disabled={!canNext || saving}>{saving ? "Confirming..." : "Sign & Create Automation"}</Button>}</div>
        </motion.div>
      </motion.div>}
    </AnimatePresence>
  );
}

function Step({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return <div><h2 className="text-xl font-semibold text-foreground">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{detail}</p><div className="mt-5">{children}</div></div>;
}

function Verified({ label, value }: { label: string; value: string }) {
  return <div className="mt-3 rounded-lg border border-success/25 bg-success/10 p-3"><div className="flex items-center gap-2 text-sm font-medium text-success"><CheckCircle2 size={15} /> Recipient verified</div><p className="mt-1 text-xs text-muted-foreground">{label}</p><p className="mt-0.5 break-all font-mono text-xs text-foreground">{value}</p></div>;
}
