"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, CheckCircle2, Upload, ClipboardPaste, Keyboard, Trash2, Plus, AlertTriangle, Lock, Wallet } from "lucide-react";
import { encodeFunctionData, type Hex } from "viem";
import { Badge, Button, Card, Input } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { useToast } from "@/components/Toast";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { calculateFee } from "@/lib/payment/feeEngine";
import {
  computeDistribution, findDuplicateInputs, parseRecipientsCsv, parseRecipientsPaste,
  type DistributionMethod, type RecipientDraft,
} from "@/lib/automation/bulk";

const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** Fire a wallet tx and resolve with its hash — same tiny helper the
 *  single-recipient creator uses (components/dashboard/../automations page),
 *  duplicated here rather than imported since it's a 6-line utility, not
 *  business logic worth sharing a module boundary for. */
async function sendWalletTx(from: string, to: string, data: string, value?: bigint): Promise<string> {
  const tx: Record<string, string> = { from, to, data };
  if (value != null) tx.value = `0x${value.toString(16)}`;
  const hash = (await window.ethereum?.request({ method: "eth_sendTransaction", params: [tx] })) as string | undefined;
  if (!hash) throw new Error("Transaction was cancelled in your wallet.");
  return hash;
}

async function waitForReceipt(hash: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = (await window.ethereum?.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
    if (r) {
      if (r.status === "0x0") throw new Error("The on-chain transaction failed. Nothing was created.");
      return;
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw new Error("Timed out waiting for the transaction to confirm. Check your wallet and try again.");
}

type Cadence = "once" | "daily" | "weekly" | "monthly" | "custom";
type IntervalUnit = "days" | "weeks" | "months";
type EndMode = "never" | "after_count" | "until_date";

interface ResolvedRow {
  input: string;
  address: string;
  domain: string | null;
  amount: number;
  note?: string;
  error?: string;
}

type OnchainConfig = { chainId: number; executor: string | null; usdc: { address: string; decimals: number }; walletModeAvailable: boolean };

const STEPS = ["Recipients", "Distribution", "Schedule", "Execution Mode", "Review"];

export function BulkPaymentCreator({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const wallet = useWallet();
  const balances = useWalletBalances(wallet.address);
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [inputTab, setInputTab] = useState<"paste" | "csv" | "excel" | "manual">("paste");
  const [pasteText, setPasteText] = useState("");
  const [drafts, setDrafts] = useState<RecipientDraft[]>([]);
  const [manualAddr, setManualAddr] = useState("");
  const [manualAmt, setManualAmt] = useState("");
  const [manualNote, setManualNote] = useState("");
  const [method, setMethod] = useState<DistributionMethod>("equal");
  const [token, setToken] = useState<"MON" | "USDC">("USDC");
  const [totalAmount, setTotalAmount] = useState("");
  const [fixedAmount, setFixedAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("once");
  const [intervalCount, setIntervalCount] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("weeks");
  const [date, setDate] = useState(() => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [time, setTime] = useState("10:00");
  const [endMode, setEndMode] = useState<EndMode>("never");
  const [endCount, setEndCount] = useState("12");
  const [endDate, setEndDate] = useState(() => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos");
  const [purpose, setPurpose] = useState("Business");
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  const [resolvedRows, setResolvedRows] = useState<ResolvedRow[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState<string | null>(null);

  const startAt = useMemo(() => new Date(`${date}T${time}:00`).getTime(), [date, time]);

  function loadConfig() {
    fetch("/api/automation-config").then((r) => r.json()).then(setConfig).catch(() => {});
  }

  function reset() {
    setStep(1); setDrafts([]); setPasteText(""); setManualAddr(""); setManualAmt(""); setManualNote("");
    setMethod("equal"); setTotalAmount(""); setFixedAmount(""); setResolvedRows(null); setPurpose("Business");
  }

  function close() { reset(); onClose(); }

  function handlePaste() {
    const parsed = parseRecipientsPaste(pasteText);
    setDrafts(parsed);
  }

  function handleCsvFile(file: File) {
    file.text().then((text) => setDrafts(parseRecipientsCsv(text)));
  }

  async function handleExcelFile(file: File) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const out: RecipientDraft[] = rows.map((row) => {
      const keys = Object.keys(row).reduce<Record<string, string>>((acc, k) => { acc[k.toLowerCase().trim()] = k; return acc; }, {});
      const addrKey = keys["address"] ?? keys["wallet"] ?? keys["recipient"] ?? Object.keys(row)[0];
      const amtKey = keys["amount"];
      const pctKey = keys["percentage"] ?? keys["percent"];
      const noteKey = keys["note"] ?? keys["notes"];
      return {
        input: String(row[addrKey] ?? "").trim(),
        amount: amtKey ? Number(row[amtKey]) : undefined,
        percentage: pctKey ? Number(row[pctKey]) : undefined,
        note: noteKey ? String(row[noteKey] || "") || undefined : undefined,
      };
    }).filter((d) => d.input);
    setDrafts(out);
  }

  function addManualRow() {
    if (!manualAddr.trim()) return;
    setDrafts((d) => [...d, { input: manualAddr.trim(), amount: manualAmt ? Number(manualAmt) : undefined, note: manualNote || undefined }]);
    setManualAddr(""); setManualAmt(""); setManualNote("");
  }

  function removeDraft(i: number) {
    setDrafts((d) => d.filter((_, idx) => idx !== i));
  }

  const duplicateInputs = useMemo(() => findDuplicateInputs(drafts), [drafts]);

  // Percentage rows are edited inline once the method is chosen — stored
  // directly on the draft objects so computeDistribution can read them.
  function setDraftField(i: number, field: "amount" | "percentage" | "note", value: string) {
    setDrafts((d) => d.map((row, idx) => idx === i ? { ...row, [field]: field === "note" ? value : (value === "" ? undefined : Number(value)) } : row));
  }

  const distribution = useMemo(() => {
    const total = method === "equal" || method === "percentage" ? Number(totalAmount) : method === "fixed" ? Number(fixedAmount) : undefined;
    return computeDistribution(method, drafts, total);
  }, [method, drafts, totalAmount, fixedAmount]);

  async function resolveAll() {
    if (duplicateInputs.length > 0) { toast(`Duplicate recipient: ${duplicateInputs[0]}`); return; }
    if (!distribution.ok) { toast(distribution.error ?? "Fix the distribution before continuing."); return; }
    setResolving(true);
    try {
      const rows: ResolvedRow[] = [];
      for (const row of distribution.rows) {
        try {
          const r = await fetch(`/api/automations?resolve=${encodeURIComponent(row.input)}`).then((res) => res.json());
          if (!r.success) { rows.push({ input: row.input, address: "", domain: null, amount: row.amount, note: row.note, error: r.error ?? "Could not resolve." }); continue; }
          rows.push({ input: row.input, address: r.recipient, domain: r.domain, amount: row.amount, note: row.note });
        } catch {
          rows.push({ input: row.input, address: "", domain: null, amount: row.amount, note: row.note, error: "Could not resolve." });
        }
      }
      setResolvedRows(rows);
      const hasErrors = rows.some((r) => r.error);
      if (!hasErrors) setStep(3);
      else toast("Some recipients couldn't be resolved — fix them before continuing.");
    } finally {
      setResolving(false);
    }
  }

  const totalToPay = resolvedRows?.reduce((s, r) => s + r.amount, 0) ?? distribution.total;
  const balance = token === "MON" ? balances.mon : balances.usdc;
  const insufficientBalance = balance != null && totalToPay > Number(balance);
  const platformFee = calculateFee("wallet_automation", totalToPay || 0);
  const estimateGas = `~${(0.002 * Math.max(1, resolvedRows?.length ?? drafts.length)).toFixed(4)} MON`;

  const endUntilMs = new Date(`${endDate}T23:59:59`).getTime();
  const endCondition = cadence === "once" || endMode === "never"
    ? { type: "never" as const }
    : endMode === "after_count"
      ? { type: "after_count" as const, totalRuns: Math.max(1, Math.floor(Number(endCount) || 1)) }
      : { type: "until_date" as const, untilMs: endUntilMs };

  function cadenceLabel() {
    if (cadence === "once") return "One time";
    if (cadence === "custom") return `Every ${intervalCount} ${intervalUnit}`;
    return cadence[0].toUpperCase() + cadence.slice(1);
  }

  async function activate() {
    if (!wallet.address || !resolvedRows || !config) return;
    setSaving(true);
    try {
      if (wallet.isWrongNetwork) await wallet.switchNetwork();
      const isNative = token === "MON";
      const decimals = isNative ? 18 : config.usdc.decimals;
      const totalWei = (() => {
        try {
          return BigInt(Math.round(totalToPay * 10 ** decimals));
        } catch { return 0n; }
      })();

      // This message MUST byte-for-byte match bulkSignatureMessage() in
      // app/api/automations/route.ts — the server independently recomputes
      // it from the SAME resolved rows this client sends, and rejects the
      // signature if they don't match. Uses the browser's native Web Crypto
      // (always available in a secure context — localhost or https), same
      // SHA-256 digest algorithm the server uses via node:crypto.
      const enc = new TextEncoder().encode(resolvedRows.map((r) => `${r.address.toLowerCase()}:${r.amount}`).join("|"));
      const digestBuf = await crypto.subtle.digest("SHA-256", enc);
      const rowsDigest = [...new Uint8Array(digestBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const message = [
        "PayAI Bulk Payment",
        `Wallet: ${wallet.address}`,
        `Recipients: ${resolvedRows.length}`,
        `Recipients digest: ${rowsDigest}`,
        `Total: ${totalToPay} ${token}`,
        `Distribution: ${method}`,
        `Automation: ${cadence}`,
        `First execution: ${new Date(startAt).toISOString()}`,
        `Timezone: ${timezone}`,
        `Purpose: ${purpose}`,
        "Network: Monad Mainnet",
      ].join("\n");

      setSavingStep("Confirm the bulk payment in your wallet");
      const signature = await window.ethereum?.request({ method: "personal_sign", params: [message, wallet.address] }) as string | undefined;
      if (!signature) throw new Error("Wallet confirmation was cancelled.");

      if (!config.executor) throw new Error("Wallet Automation isn't available right now.");
      const tokenAddr = isNative ? null : config.usdc.address;
      if (isNative) throw new Error("MON isn't available for Bulk Payments yet — use USDC.");
      setSavingStep("Approve PayAI to send from your wallet");
      const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [config.executor as Hex, totalWei] });
      const hash = await sendWalletTx(wallet.address, tokenAddr!, data);
      setSavingStep("Waiting for approval to confirm on Monad");
      await waitForReceipt(hash);

      setSavingStep("Activating your bulk payment");
      const body = {
        walletAddress: wallet.address, token, cadence,
        intervalCount: Number(intervalCount), intervalUnit, startAt, timezone, purpose,
        signature, signatureMessage: message, fundingMode: "wallet", endCondition,
        recipients: resolvedRows.map((r) => ({ input: r.input, amount: r.amount, note: r.note })),
        distributionMethod: method,
      };
      const r = await fetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "Could not create the bulk payment.");
      toast("Bulk payment created");
      onCreated();
      close();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Bulk payment creation failed");
    } finally {
      setSaving(false);
      setSavingStep(null);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm"
          onClick={close}
          onAnimationStart={() => { if (open) loadConfig(); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }}
            className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-border bg-panel shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <p className="text-sm font-semibold tracking-tight text-foreground">Bulk Payment</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Step {step} of {STEPS.length}: {STEPS[step - 1]}</p>
              </div>
              <button onClick={close} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground"><X size={16} /></button>
            </div>

            <div className="grid gap-6 p-6 lg:grid-cols-[190px_1fr]">
              <div className="space-y-1">
                {STEPS.map((label, i) => (
                  <div key={label} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm ${step === i + 1 ? "bg-primary/12 font-medium text-primary" : i + 1 < step ? "text-foreground" : "text-muted-foreground"}`}>
                    {i + 1 < step ? <CheckCircle2 size={15} className="shrink-0 text-primary" /> : <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${step === i + 1 ? "border-primary text-primary" : "border-current"}`}>{i + 1}</span>}
                    {label}
                  </div>
                ))}
              </div>

              <div className="min-h-[420px]">
                {step === 1 && (
                  <div>
                    <p className="text-base font-semibold text-foreground">Recipients</p>
                    <p className="mt-1 text-sm text-muted-foreground">Paste addresses, upload a CSV or Excel file, or add recipients one at a time.</p>
                    <div className="mt-4 flex gap-2">
                      {([["paste", "Paste", ClipboardPaste], ["csv", "CSV", Upload], ["excel", "Excel", Upload], ["manual", "Manual", Keyboard]] as const).map(([tab, label, Icon]) => (
                        <button key={tab} onClick={() => setInputTab(tab)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${inputTab === tab ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"}`}>
                          <Icon size={13} /> {label}
                        </button>
                      ))}
                    </div>

                    <div className="mt-4">
                      {inputTab === "paste" && (
                        <div>
                          <textarea
                            value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                            placeholder={"0xabc...\n0xdef... , alice.nad\n0x123..."}
                            rows={5}
                            className="w-full rounded-lg border border-border bg-input p-3 text-sm text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-ring"
                          />
                          <Button variant="secondary" className="mt-2 !px-3 !py-1.5 text-xs" onClick={handlePaste}>Add to list</Button>
                        </div>
                      )}
                      {inputTab === "csv" && (
                        <div>
                          <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvFile(f); }} className="text-sm text-muted-foreground" />
                          <p className="mt-1.5 text-xs text-muted-foreground">Columns: address (required), amount, percentage, note — in any order, with or without a header row.</p>
                        </div>
                      )}
                      {inputTab === "excel" && (
                        <div>
                          <input type="file" accept=".xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleExcelFile(f); }} className="text-sm text-muted-foreground" />
                          <p className="mt-1.5 text-xs text-muted-foreground">First sheet is used. Columns: address, amount, percentage, note.</p>
                        </div>
                      )}
                      {inputTab === "manual" && (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="flex-1"><label className="mb-1 block text-xs text-muted-foreground">Address or .nad domain</label><Input value={manualAddr} onChange={(e) => setManualAddr(e.target.value)} className="w-full" /></div>
                          <div><label className="mb-1 block text-xs text-muted-foreground">Amount (optional)</label><Input value={manualAmt} onChange={(e) => setManualAmt(e.target.value.replace(/[^0-9.]/g, ""))} className="w-28" /></div>
                          <div><label className="mb-1 block text-xs text-muted-foreground">Note (optional)</label><Input value={manualNote} onChange={(e) => setManualNote(e.target.value)} className="w-32" /></div>
                          <Button className="!px-3 !py-2" onClick={addManualRow}><Plus size={14} /></Button>
                        </div>
                      )}
                    </div>

                    {drafts.length > 0 && (
                      <div className="mt-4 rounded-lg border border-border">
                        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
                          <span>{drafts.length} recipient{drafts.length === 1 ? "" : "s"}</span>
                          {duplicateInputs.length > 0 && <span className="flex items-center gap-1 text-danger"><AlertTriangle size={12} /> {duplicateInputs.length} duplicate{duplicateInputs.length === 1 ? "" : "s"}</span>}
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                          {drafts.map((d, i) => (
                            <div key={i} className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs last:border-b-0">
                              <span className="min-w-0 flex-1 truncate font-mono text-foreground">{d.input}</span>
                              {d.amount != null && <span className="text-muted-foreground">{d.amount}</span>}
                              {d.note && <span className="truncate text-muted-foreground/70">{d.note}</span>}
                              <button onClick={() => removeDraft(i)} className="text-muted-foreground hover:text-danger"><Trash2 size={12} /></button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-5 flex justify-end">
                      <Button disabled={drafts.length === 0 || duplicateInputs.length > 0} onClick={() => setStep(2)}>Continue</Button>
                    </div>
                  </div>
                )}

                {step === 2 && (
                  <div>
                    <p className="text-base font-semibold text-foreground">Distribution method</p>
                    <p className="mt-1 text-sm text-muted-foreground">How should {drafts.length} recipients be paid?</p>
                    <div className="mt-4 flex gap-2">
                      {(["MON", "USDC"] as const).map((t) => (
                        <button key={t} onClick={() => setToken(t)} className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${token === t ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-foreground hover:border-primary/30"}`}>
                          <TokenLogo token={t} size={15} /> {t}
                        </button>
                      ))}
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      {([["equal", "Equal Split", "Every recipient gets the same share of a total."], ["fixed", "Fixed Amount", "Every recipient gets the same explicit amount."], ["percentage", "Percentage", "Each recipient gets a % share of a total."], ["custom", "Custom Amount", "Set an exact amount per recipient."]] as [DistributionMethod, string, string][]).map(([m, label, desc]) => (
                        <button key={m} onClick={() => setMethod(m)} className={`rounded-lg border p-3 text-left transition-colors ${method === m ? "border-primary/50 bg-primary/[0.06]" : "border-border hover:border-primary/30"}`}>
                          <p className="text-sm font-medium text-foreground">{label}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                        </button>
                      ))}
                    </div>

                    {(method === "equal" || method === "fixed" || method === "percentage") && (
                      <div className="mt-4">
                        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">{method === "fixed" ? `Amount per recipient (${token})` : `Total amount to allocate (${token})`}</label>
                        <Input value={method === "fixed" ? fixedAmount : totalAmount} onChange={(e) => (method === "fixed" ? setFixedAmount : setTotalAmount)(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" className="w-48" />
                      </div>
                    )}

                    {method === "percentage" && (
                      <div className="mt-4 max-h-48 overflow-y-auto rounded-lg border border-border">
                        {drafts.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs last:border-b-0">
                            <span className="min-w-0 flex-1 truncate font-mono">{d.input}</span>
                            <Input value={d.percentage != null ? String(d.percentage) : ""} onChange={(e) => setDraftField(i, "percentage", e.target.value.replace(/[^0-9.]/g, ""))} className="w-20 !py-1" placeholder="%" />
                          </div>
                        ))}
                      </div>
                    )}

                    {method === "custom" && (
                      <div className="mt-4 max-h-48 overflow-y-auto rounded-lg border border-border">
                        {drafts.map((d, i) => (
                          <div key={i} className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs last:border-b-0">
                            <span className="min-w-0 flex-1 truncate font-mono">{d.input}</span>
                            <Input value={d.amount != null ? String(d.amount) : ""} onChange={(e) => setDraftField(i, "amount", e.target.value.replace(/[^0-9.]/g, ""))} className="w-24 !py-1" placeholder="0.00" />
                          </div>
                        ))}
                      </div>
                    )}

                    {!distribution.ok && distribution.error && <p className="mt-3 text-xs text-danger">{distribution.error}</p>}
                    {distribution.ok && <p className="mt-3 text-xs text-muted-foreground">Total: <span className="font-medium text-foreground">{distribution.total.toLocaleString()} {token}</span></p>}

                    <div className="mt-5 flex justify-between">
                      <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>
                      <Button disabled={!distribution.ok || resolving} onClick={resolveAll}>{resolving ? "Resolving…" : "Continue"}</Button>
                    </div>
                  </div>
                )}

                {step === 3 && (
                  <div>
                    <p className="text-base font-semibold text-foreground">Schedule</p>
                    <div className="mt-4 grid gap-2 sm:grid-cols-3">
                      {(["once", "daily", "weekly", "monthly", "custom"] as Cadence[]).map((c) => (
                        <button key={c} onClick={() => setCadence(c)} className={`rounded-lg border px-3 py-3 text-left text-sm capitalize transition-colors ${cadence === c ? "border-primary/50 bg-primary/[0.06] text-primary" : "border-border text-foreground hover:border-primary/30"}`}>{c === "once" ? "One Time" : c}</button>
                      ))}
                    </div>
                    {cadence === "custom" && (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">Every</span>
                        <Input value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-20" />
                        <select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)} className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground">
                          <option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option>
                        </select>
                      </div>
                    )}
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">First execution date</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                      <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Time</label><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
                      <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Timezone</label><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
                    </div>
                    {cadence !== "once" && (
                      <div className="mt-4">
                        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">When should it end?</label>
                        <div className="flex flex-wrap gap-2">
                          {([["never", "No end date"], ["after_count", "After N runs"], ["until_date", "On a date"]] as [EndMode, string][]).map(([m, label]) => (
                            <button key={m} onClick={() => setEndMode(m)} className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${endMode === m ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/30"}`}>{label}</button>
                          ))}
                        </div>
                        {endMode === "after_count" && <div className="mt-3 flex items-center gap-2"><span className="text-sm text-muted-foreground">Stop after</span><Input value={endCount} onChange={(e) => setEndCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-24" /><span className="text-sm text-muted-foreground">runs</span></div>}
                        {endMode === "until_date" && <div className="mt-3"><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>}
                      </div>
                    )}
                    <div className="mt-4">
                      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Purpose</label>
                      <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} className="w-full" />
                    </div>
                    <div className="mt-5 flex justify-between">
                      <Button variant="secondary" onClick={() => setStep(2)}>Back</Button>
                      <Button disabled={!Number.isFinite(startAt) || startAt < Date.now() - 60_000} onClick={() => setStep(4)}>Continue</Button>
                    </div>
                  </div>
                )}

                {step === 4 && (
                  <div>
                    <p className="text-base font-semibold text-foreground">Execution mode</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-primary/50 bg-primary/[0.06] p-4">
                        <div className="flex items-center gap-2"><Wallet size={16} className="text-primary" /><p className="text-sm font-semibold text-foreground">Wallet Automation</p></div>
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Funds remain in your wallet until each payment runs. Required for Bulk Payments.</p>
                      </div>
                      <div className="rounded-xl border border-border p-4 opacity-50">
                        <div className="flex items-center gap-2"><Lock size={16} className="text-muted-foreground" /><p className="text-sm font-semibold text-foreground">Reserved Funds</p></div>
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Not available for Bulk Payments — the on-chain vault can only guarantee funds for one recipient per reservation, not many.</p>
                      </div>
                    </div>
                    <div className="mt-5 flex justify-between">
                      <Button variant="secondary" onClick={() => setStep(3)}>Back</Button>
                      <Button onClick={() => setStep(5)}>Continue</Button>
                    </div>
                  </div>
                )}

                {step === 5 && resolvedRows && (
                  <div>
                    <p className="text-base font-semibold text-foreground">Review</p>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      {[
                        { label: "Total Recipients", value: String(resolvedRows.length) },
                        { label: "Total Amount", value: `${totalToPay.toLocaleString()} ${token}` },
                        { label: "Estimated Network Fees", value: estimateGas },
                        { label: "Platform Fee", value: platformFee.label },
                        { label: "Distribution Method", value: method },
                        { label: "Execution Mode", value: "Wallet Automation" },
                        { label: "Execution Time", value: new Date(startAt).toLocaleString() },
                        { label: "Timezone", value: timezone },
                      ].map((r) => (
                        <div key={r.label} className="rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-3.5 py-2.5">
                          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{r.label}</p>
                          <p className="mt-0.5 truncate text-sm font-semibold text-foreground">{r.value}</p>
                        </div>
                      ))}
                    </div>
                    {insufficientBalance && <p className="mt-3 flex items-center gap-1.5 text-xs text-danger"><AlertTriangle size={12} /> Total exceeds your {token} balance ({balance}).</p>}
                    <div className="mt-4 max-h-48 overflow-y-auto rounded-lg border border-border">
                      {resolvedRows.map((r, i) => (
                        <div key={i} className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs last:border-b-0">
                          <span className="min-w-0 flex-1 truncate font-mono text-foreground">{r.domain ?? r.address}</span>
                          <span className="text-muted-foreground">{r.amount} {token}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-5 flex justify-between">
                      <Button variant="secondary" onClick={() => setStep(4)} disabled={saving}>Back</Button>
                      <Button disabled={saving || insufficientBalance} onClick={activate}>{saving ? (savingStep ?? "Activating…") : "Activate Bulk Payment"}</Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
