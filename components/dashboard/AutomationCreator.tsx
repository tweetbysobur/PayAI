"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { X, CheckCircle2, ArrowRight } from "lucide-react";
import { encodeFunctionData, parseUnits, type Hex } from "viem";
import { Badge, Button, Input } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useTokenBalance } from "@/lib/hooks/useTokenBalance";
import { useTokenPrices, formatUsd } from "@/lib/hooks/useTokenPrices";
import { TokenSelector, type TokenInfo } from "@/components/dashboard/TokenSelector";
import { useModalA11y } from "@/lib/hooks/useModalA11y";
import { AUTOMATION_VAULT_ABI } from "@/lib/monad/abi";
import { toParseableAmount } from "@/lib/monad/verify";
import { calculateFee } from "@/lib/payment/feeEngine";
import type { TemplateCategory } from "@/lib/automation/templates";
import {
  NATIVE_TOKEN_ADDRESS, ERC20_APPROVE_ABI, PURPOSES,
  autoId32, confirmTx, rememberPendingReservation, forgetPendingReservation,
  signatureMessage, cadenceLabel, annualVolume, countOccurrences, money, short,
  Info, ReviewGrid,
  type Automation, type AutomationSeed, type Cadence, type IntervalUnit,
  type EndMode, type EndCondition, type FundingMode, type OnchainConfig,
} from "@/components/dashboard/automationShared";

/**
 * The Payment Automation creation wizard — the ONE place an automation is
 * created, from either the standalone Automations page or in-chat from Ask
 * PayAI. Extracted verbatim from app/dashboard/automations/page.tsx so both
 * surfaces drive the exact same creation flow: same wallet signature, same
 * ERC-20 approval / vault reserve, same signed POST /api/automations, same
 * validation and error handling. Nothing about the creation logic changed in
 * the move — only its file home, so it can be mounted in two places.
 */
export function AutomationCreator({ open, seed, onClose, onCreated }: { open: boolean; seed?: AutomationSeed | null; onClose: () => void; onCreated: (created?: { nextRun: number; cadence: Cadence; amount: number; token: string; recipient: string; domain: string | null }) => void }) {
  const wallet = useWallet();
  const { toast } = useToast();
  useModalA11y(open, onClose);
  const [step, setStep] = useState(1);
  const [recipientInput, setRecipientInput] = useState("");
  const [resolved, setResolved] = useState<{ recipient: string; domain: string | null } | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const { balance, loading: balanceLoading } = useTokenBalance(tokenInfo?.address ?? null, tokenInfo?.decimals ?? null, wallet.address);
  // Unit price fetched once per token (module-cached); the dollar figures are
  // plain multiplications, so typing stays instant. Derived after `amount` is
  // declared below.
  const { usdValue } = useTokenPrices(tokenInfo ? [{ address: tokenInfo.address, decimals: tokenInfo.decimals }] : []);
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [intervalCount, setIntervalCount] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("weeks");
  const [date, setDate] = useState(() => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [time, setTime] = useState("10:00");
  const [endMode, setEndMode] = useState<EndMode>("never");
  const [endCount, setEndCount] = useState("12");
  const [endDate, setEndDate] = useState(() => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos");
  const [purpose, setPurpose] = useState("Savings");
  const [customPurpose, setCustomPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState<string | null>(null);
  const [fundingMode, setFundingMode] = useState<FundingMode>("wallet");
  const [config, setConfig] = useState<OnchainConfig | null>(null);
  /** Set only when this creation started from an Automation Template — carried
   *  through to the create() call so the record stores what it came from.
   *  Never set for a duplicate or an AI-parsed draft. */
  const [templateMeta, setTemplateMeta] = useState<{ id: string; category: TemplateCategory } | null>(null);
  const startAt = useMemo(() => new Date(`${date}T${time}:00`).getTime(), [date, time]);
  const amountNum = Number(amount);
  const balanceNum = balance == null ? null : Number(balance);
  const amountUsd = tokenInfo ? formatUsd(usdValue(tokenInfo.address, amountNum)) : null;
  const balanceUsd = tokenInfo && balanceNum != null ? formatUsd(usdValue(tokenInfo.address, balanceNum)) : null;
  const invalidAmount = !Number.isFinite(amountNum) || amountNum <= 0 || (balanceNum != null && amountNum > balanceNum);
  const finalPurpose = purpose === "Other" ? customPurpose.trim() : purpose;
  const estimateGas = tokenInfo?.address === NATIVE_TOKEN_ADDRESS ? "0.002 MON" : "0.004 MON";
  const platformFee = calculateFee(fundingMode === "reserved" ? "reserved_funds" : "wallet_automation", amountNum || 0);

  useEffect(() => {
    if (!open) return;
    setStep(1); setRecipientError(null);
    if (seed) {
      // Pre-fill from either a duplicated automation or an AI-parsed draft —
      // either way, the recipient still goes through the same live
      // re-verification as a fresh entry; nothing here is trusted blindly,
      // and nothing is created until the user reviews and signs below.
      if (seed.domain || seed.recipient) setRecipientInput(seed.domain ?? seed.recipient ?? "");
      setResolved(null);
      if (seed.tokenAddress) {
        // A real Duplicate carries the exact token forward, address and all.
        setTokenInfo({
          address: seed.tokenAddress, symbol: seed.token ?? "", name: seed.token ?? "",
          decimals: seed.tokenDecimals ?? 18, logoURI: seed.tokenLogo ?? null, verified: false,
        });
      } else if (seed.token) {
        // A Template only hints at a symbol — resolve it against the verified
        // list so the wizard opens with a real, selectable token pre-filled.
        fetch(`/api/tokens?q=${encodeURIComponent(seed.token)}`)
          .then((r) => r.json())
          .then((j) => { if (j.success && j.tokens[0]) setTokenInfo(j.tokens[0]); })
          .catch(() => {});
      } else {
        setTokenInfo(null);
      }
      if (seed.amount != null) setAmount(String(seed.amount));
      if (seed.cadence) setCadence(seed.cadence);
      if (seed.intervalCount != null) setIntervalCount(String(seed.intervalCount));
      if (seed.intervalUnit) setIntervalUnit(seed.intervalUnit);
      if (seed.nextRun) {
        const d = new Date(seed.nextRun);
        setDate(d.toISOString().slice(0, 10));
        setTime(d.toTimeString().slice(0, 5));
      }
      const seedPurpose = seed.purpose ?? seed.memo;
      setPurpose(seedPurpose && PURPOSES.includes(seedPurpose) ? seedPurpose : "Other");
      setCustomPurpose(seedPurpose && PURPOSES.includes(seedPurpose) ? "" : (seedPurpose ?? ""));
      if (seed.fundingMode) setFundingMode(seed.fundingMode);
      if (seed.endMode) setEndMode(seed.endMode);
      setTemplateMeta(seed.templateId && seed.templateCategory ? { id: seed.templateId, category: seed.templateCategory } : null);
    } else {
      setRecipientInput(""); setResolved(null); setTokenInfo(null); setAmount(""); setPurpose("Savings"); setCustomPurpose("");
      setFundingMode("wallet"); setEndMode("never"); setTemplateMeta(null);
    }
  }, [open, seed]);

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

  // Load the public on-chain addresses the browser needs to build approve/reserve txs.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/automation-config").then((r) => r.json()).then((c: OnchainConfig) => { if (!cancelled) setConfig(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // Wallet Automation needs an ERC-20 allowance: any non-native token works
  // directly; native MON only works if WMON is configured. When unavailable
  // for the chosen token, the choice collapses to Reserved Funds so we never
  // offer an impossible path.
  const isNativeToken = tokenInfo?.address === NATIVE_TOKEN_ADDRESS;
  const walletAvailableForToken = tokenInfo ? (isNativeToken ? !!config?.wmon : !!config?.walletModeAvailable) : false;
  const reservedAvailable = !!config?.reservedModeAvailable;
  useEffect(() => {
    if (fundingMode === "wallet" && !walletAvailableForToken && reservedAvailable) setFundingMode("reserved");
  }, [fundingMode, walletAvailableForToken, reservedAvailable]);

  // End condition — the user controls how long this runs, so the total that
  // gets authorized/reserved is always a number they chose, never a surprise.
  const endUntilMs = useMemo(() => new Date(`${endDate}T23:59:59`).getTime(), [endDate]);
  const occurrences = useMemo(() => countOccurrences({
    startAt, cadence, intervalCount: Number(intervalCount) || 1, intervalUnit,
    endMode, endCount: Number(endCount) || 1, endUntilMs,
  }), [startAt, cadence, intervalCount, intervalUnit, endMode, endCount, endUntilMs]);

  const perPayment = amountNum || 0;
  // Total the schedule will move over its whole (bounded) life. null = open-ended.
  const totalScheduled = occurrences != null ? perPayment * occurrences : null;

  // Wallet Automation only grants an ALLOWANCE (no funds move until each run):
  // a bounded schedule approves its exact total; an open-ended one approves ~a
  // year and re-approves later. Reserved Funds MOVES real money up front, so a
  // bounded schedule reserves its exact total (true guaranteed execution) while
  // an open-ended one reserves only the next payment (can't lock infinity).
  const walletBudgetAmount = totalScheduled != null
    ? totalScheduled
    : annualVolume({ amount: perPayment, token: tokenInfo?.symbol ?? "", cadence, intervalCount: Number(intervalCount), intervalUnit } as Automation);
  const reservedBudgetAmount = totalScheduled != null ? totalScheduled : perPayment;
  // What the Review screen shows depends on the chosen mode.
  const budgetAmount = fundingMode === "wallet" ? walletBudgetAmount : reservedBudgetAmount;

  const endCondition: EndCondition = cadence === "once" || endMode === "never"
    ? { type: "never" }
    : endMode === "after_count"
      ? { type: "after_count", totalRuns: Math.max(1, Math.floor(Number(endCount) || 1)) }
      : { type: "until_date", untilMs: endUntilMs };

  async function create() {
    if (!wallet.address || !resolved || invalidAmount || !finalPurpose || !config || !tokenInfo) return;
    const isNative = tokenInfo.address === NATIVE_TOKEN_ADDRESS;
    const decimals = tokenInfo.decimals;
    // toParseableAmount, not String() — a sub-1-unit amount below the
    // token's own precision floor stringifies to exponential notation,
    // which parseUnits rejects outright.
    const budget = parseUnits(toParseableAmount(walletBudgetAmount, decimals), decimals);
    const reservedBudget = parseUnits(toParseableAmount(reservedBudgetAmount, decimals), decimals);
    setSaving(true);
    try {
      if (wallet.isWrongNetwork) await wallet.switchNetwork();
      const message = signatureMessage({ walletAddress: wallet.address, recipient: resolved.recipient, amount: amountNum, token: tokenInfo.symbol, cadence, startAt, timezone, purpose: finalPurpose });
      setSavingStep("Confirm the automation in your wallet");
      const signature = await wallet.signMessage(message);

      const body: Record<string, unknown> = {
        walletAddress: wallet.address, recipient: recipientInput, amount: amountNum, token: tokenInfo.symbol, tokenAddress: tokenInfo.address, cadence,
        intervalCount: Number(intervalCount), intervalUnit, startAt, timezone, purpose: finalPurpose,
        signature, signatureMessage: message, fundingMode, endCondition,
        ...(templateMeta ? { templateId: templateMeta.id, templateCategory: templateMeta.category } : {}),
      };

      if (fundingMode === "wallet") {
        // Non-custodial: approve the executor to pull up to the budget. Native
        // MON has no ERC-20 allowance, so it lands with the WMON address instead.
        if (!config.executor) throw new Error("Wallet Automation isn't available right now.");
        const token = isNative ? config.wmon : tokenInfo.address;
        if (!token) throw new Error("This token can't use Wallet Automation yet. Choose Reserved Funds.");
        setSavingStep("Approve PayAI to send from your wallet");
        const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [config.executor as Hex, budget] });
        setSavingStep("Waiting for approval to confirm on Monad");
        await confirmTx(wallet, token, data);
      } else {
        // Reserved Funds: deposit the budget into the vault, keyed to a client id.
        if (!config.vault) throw new Error("Reserved Funds isn't available right now.");
        const id = `sch_${crypto.randomUUID()}`;
        body.id = id;
        if (!isNative) {
          // ERC-20 must approve the vault before it can pull the reserve.
          setSavingStep("Approve the reserved amount");
          const approveData = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [config.vault as Hex, reservedBudget] });
          await confirmTx(wallet, tokenInfo.address, approveData);
        }
        setSavingStep("Reserve funds for this automation");
        const reserveData = encodeFunctionData({
          abi: AUTOMATION_VAULT_ABI, functionName: "reserve",
          args: [autoId32(id), (isNative ? "0x0000000000000000000000000000000000000000" : tokenInfo.address) as Hex, resolved.recipient as Hex, reservedBudget],
        });

        // Write the id down BEFORE the funds move.
        //
        // reserve() moves real money, and the automation record is only saved
        // after it. If anything between the two fails — validation, a dropped
        // request, a closed tab — the funds are in the vault and the id, which
        // is generated in this tab and needed by refund(), is gone on reload.
        // That is how 400 MON became unrecoverable-by-UI once already.
        // Persisting first means a failed create leaves a durable handle, so
        // the refund banner can surface the money without the user having to
        // hunt down a transaction hash. Cleared on success below.
        rememberPendingReservation(id, wallet.address);

        setSavingStep("Waiting for the reservation to confirm on Monad");
        const rHash = await confirmTx(wallet, config.vault, reserveData, isNative ? reservedBudget : undefined);
        body.reserveTxHash = rHash;
      }

      setSavingStep("Activating your automation");
      const r = await fetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error || "Could not create automation.");
      // Record exists now, so the pending handle is no longer the only way
      // back to the funds — the automation itself is.
      if (typeof body.id === "string") forgetPendingReservation(body.id);
      toast("Automation created");
      // Pass the real created fields back so a caller (Ask PayAI) can render a
      // success state from actual data — nextRun comes from the record the
      // server just returned, never invented. The standalone page ignores the
      // argument (its onCreated just reloads the list), so behaviour there is
      // unchanged.
      onCreated({
        nextRun: typeof j.automation?.nextRun === "number" ? j.automation.nextRun : startAt,
        cadence, amount: amountNum, token: tokenInfo.symbol,
        recipient: resolved.recipient, domain: resolved.domain,
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Automation creation failed");
    } finally {
      setSaving(false);
      setSavingStep(null);
    }
  }

  const canNext = step === 1 ? !!resolved : step === 2 ? !!tokenInfo && !invalidAmount : step === 3 ? cadence !== "custom" || Number(intervalCount) > 0 : step === 4 ? Number.isFinite(startAt) && startAt > Date.now() - 60_000 : step === 5 ? !!finalPurpose : true;

  // No AnimatePresence — see the note in components/dashboard/TemplatePicker.tsx.
  return (
    <>
      {open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: "easeOut" }} className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 backdrop-blur-sm" onClick={onClose}>
        <motion.div role="dialog" aria-modal="true" aria-label="Create Payment Automation" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.2, ease: "easeOut" }} className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-border bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-border px-6 py-4"><div><p className="text-sm font-semibold tracking-tight text-foreground">Create Payment Automation</p><p className="mt-0.5 text-xs text-muted-foreground">Step {step} of 6</p></div><button onClick={onClose} aria-label="Close automation creator" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X size={16} /></button></div>
          <div className="grid gap-6 p-6 lg:grid-cols-[190px_1fr]">
            <div className="space-y-1">{["Recipient", "Payment", "Automation", "Execution Time", "Purpose", "Review"].map((label, i) => <button key={label} onClick={() => setStep(i + 1)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${step === i + 1 ? "bg-primary/12 font-medium text-primary-ink" : i + 1 < step ? "text-foreground hover:bg-input/50" : "text-muted-foreground hover:bg-input/40"}`}>{i + 1 < step ? <CheckCircle2 size={15} className="shrink-0 text-primary-ink" /> : <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${step === i + 1 ? "border-primary text-primary-ink" : "border-current"}`}>{i + 1}</span>} {label}</button>)}</div>
            <div className="min-h-[420px]">
              {step === 1 && <Step title="Recipient" detail="Enter a wallet address or .nads domain. PayAI verifies it before you continue."><Input value={recipientInput} onChange={(e) => setRecipientInput(e.target.value)} placeholder=".nad domain or 0x wallet address" className="w-full" />{resolved && <Verified label={resolved.domain ?? "Wallet address"} value={resolved.recipient} />}{recipientError && <p className="mt-2 text-sm text-danger">{recipientError}</p>}</Step>}
              {step === 2 && <Step title="Payment" detail="Choose a token and amount. Balance and gas are shown before review."><div className="max-w-xs"><TokenSelector value={tokenInfo} onChange={setTokenInfo} walletAddress={wallet.address} /></div><div className="mt-4">
                  <Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" inputMode="decimal" className="w-full" />
                  {/* Live dollar value under the field. Computed locally from a
                      cached unit price, so it updates as fast as you type —
                      no request per keystroke. Hidden entirely when the token
                      has no priceable pool, rather than showing "$0.00". */}
                  <p className="mt-1.5 min-h-[1.15rem] text-xs tabular-nums text-muted-foreground">
                    {amountUsd ? `≈ ${amountUsd}` : ""}
                  </p>
                </div><div className="mt-1 grid gap-2 sm:grid-cols-2"><Info label="Wallet Balance" value={balanceLoading ? "Loading..." : balance ? `${money(Number(balance), tokenInfo?.symbol ?? "")}${balanceUsd ? ` · ≈ ${balanceUsd}` : ""}` : "-"} /><Info label="Estimated Gas" value={estimateGas} /></div>{invalidAmount && amount && <p className="mt-2 text-sm text-danger">Enter a valid amount within your wallet balance.</p>}</Step>}
              {step === 3 && <Step title="Automation" detail="Choose the cadence. Custom stays simple in v1: every X days, weeks, or months."><div className="grid gap-2 sm:grid-cols-3">{(["once", "daily", "weekly", "monthly", "custom"] as Cadence[]).map((c) => <button key={c} onClick={() => setCadence(c)} className={choiceClass(cadence === c, "px-3 py-3 text-left capitalize")}>{c === "once" ? "One Time" : c}</button>)}</div>{cadence === "custom" && <div className="mt-4 flex items-center gap-2"><span className="text-sm text-muted-foreground">Every</span><Input value={intervalCount} onChange={(e) => setIntervalCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-20" /><select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)} className="rounded-md border border-border bg-input px-3 py-2 text-base text-foreground sm:text-sm"><option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option></select></div>}</Step>}
              {step === 4 && <Step title="Execution Time" detail="Set the first execution date and time, then choose when it ends.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">First execution date</label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Time</label><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
                  <div><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Timezone</label><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
                </div>
                <div className="mt-3 rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-3 text-sm"><span className="text-muted-foreground">First run: </span><span className="font-medium text-primary-ink">{new Date(startAt).toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
                <p className="mt-2 text-xs text-muted-foreground">
                  PayAI checks for due automations roughly every minute, so this fires close to the time you picked — not necessarily to the exact second. Need it sooner? &quot;Execute Now&quot; on the automation runs it immediately, any time.
                </p>
                {cadence !== "once" && <div className="mt-4">
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">When should it end?</label>
                  <div className="flex flex-wrap gap-2">
                    {([["never", "No end date"], ["after_count", "After N payments"], ["until_date", "On a date"]] as [EndMode, string][]).map(([m, label]) =>
                      <button key={m} onClick={() => setEndMode(m)} className={choiceClass(endMode === m, "px-3 py-2")}>{label}</button>)}
                  </div>
                  {endMode === "after_count" && <div className="mt-3 flex items-center gap-2"><span className="text-sm text-muted-foreground">Stop after</span><Input value={endCount} onChange={(e) => setEndCount(e.target.value.replace(/[^0-9]/g, ""))} className="w-24" /><span className="text-sm text-muted-foreground">payments</span></div>}
                  {endMode === "until_date" && <div className="mt-3"><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Runs until (inclusive)</label><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>}
                </div>}
                <div className="mt-4 rounded-lg border border-primary/25 bg-primary/5 p-4 text-sm">
                  {occurrences != null
                    ? <p className="text-foreground">{occurrences} payment{occurrences === 1 ? "" : "s"} × {money(perPayment, tokenInfo?.symbol ?? "")} = <strong className="text-primary-ink">{money(totalScheduled ?? 0, tokenInfo?.symbol ?? "")}</strong> total{fundingMode === "reserved" ? " reserved up front" : " authorized"}.</p>
                    : <p className="text-muted-foreground">Ongoing — no fixed total. {fundingMode === "reserved" ? "Reserved Funds sets aside only the next payment; add an end date or count to reserve the full run up front." : "You authorize about a year at a time and re-approve later — funds only move at each run."}</p>}
                </div>
              </Step>}
              {step === 5 && <Step title="Purpose" detail="Purpose powers history, analytics, receipts, and future AI insights."><div className="grid gap-2 sm:grid-cols-3">{PURPOSES.map((p) => <button key={p} onClick={() => setPurpose(p)} className={choiceClass(purpose === p, "px-3 py-2")}>{p}</button>)}</div>{purpose === "Other" && <Input value={customPurpose} onChange={(e) => setCustomPurpose(e.target.value)} placeholder="Custom purpose" className="mt-4 w-full" />}</Step>}
              {step === 6 && <Step title="Review" detail="Choose how this automation is funded, verify the details, then sign once to activate.">
                <div className="mb-5">
                  <p className="mb-2 text-sm font-medium text-foreground">How should this automation be funded?</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ModeCard
                      selected={fundingMode === "wallet"} disabled={!walletAvailableForToken}
                      onSelect={() => setFundingMode("wallet")} badge="Recommended" title="Wallet Automation"
                      description="Funds stay in your wallet until each payment runs. PayAI never holds your money."
                      pros={["Funds stay in your wallet", "Non-custodial", "More flexible"]}
                      note={isNativeToken && !walletAvailableForToken ? "Not available for MON yet — use Reserved Funds for MON." : "Payment depends on your available balance at run time."}
                    />
                    <ModeCard
                      selected={fundingMode === "reserved"} disabled={!reservedAvailable}
                      onSelect={() => setFundingMode("reserved")} badge="Guaranteed Execution" title="Reserved Funds"
                      description="Set aside funds now, dedicated to this automation, so scheduled payments always go through."
                      pros={["Higher reliability", "Funds already reserved", "Best for important payments"]}
                      note="Reserved funds stay dedicated until spent or released back to you."
                    />
                  </div>
                  <details className="mt-3 text-sm text-muted-foreground"><summary className="cursor-pointer text-primary-ink">Learn more about the two options</summary>
                    <p className="mt-2"><strong className="text-foreground">Wallet Automation</strong> keeps your money in your own wallet and only moves it at the moment each payment is due — you stay fully in control. <strong className="text-foreground">Reserved Funds</strong> moves the money into a dedicated reserve up front, so the payment can never miss for lack of balance. You can get reserved money back anytime you cancel.</p>
                  </details>
                </div>
                <ReviewGrid rows={[
                  { label: "Funding Method", value: fundingMode === "wallet" ? "Wallet Automation" : "Reserved Funds", accent: true },
                  { label: fundingMode === "wallet" ? "You authorize up to" : "You reserve", value: money(budgetAmount, tokenInfo?.symbol ?? ""), accent: true },
                  { label: "Recipient", value: recipientInput, accent: true },
                  { label: "Resolved Address", value: resolved?.recipient ?? "-", mono: true },
                  { label: "Asset", value: tokenInfo?.symbol ?? "-", accent: true },
                  { label: "Amount per payment", value: money(amountNum || 0, tokenInfo?.symbol ?? ""), accent: true },
                  { label: "Total payments", value: occurrences != null ? `${occurrences}` : "Ongoing", accent: true },
                  { label: fundingMode === "reserved" ? "Total reserved now" : "Total authorized", value: occurrences != null ? money(totalScheduled ?? 0, tokenInfo?.symbol ?? "") : "Up to ~1 year", accent: true },
                  { label: "Automation Type", value: cadence === "custom" ? `Every ${intervalCount} ${intervalUnit}` : cadenceLabel({ cadence }), accent: true },
                  { label: "Ends", value: cadence === "once" ? "Single payment" : endMode === "never" ? "No end date" : endMode === "after_count" ? `After ${Math.max(1, Math.floor(Number(endCount) || 1))} payments` : `On ${new Date(endUntilMs).toLocaleDateString()}`, accent: true },
                  { label: "Execution Time", value: new Date(startAt).toLocaleString() },
                  { label: "Purpose", value: finalPurpose || "-", accent: true },
                  { label: "Platform Fee", value: platformFee.label },
                  { label: "Estimated Gas", value: estimateGas },
                  { label: "Network", value: "Monad Mainnet" },
                  { label: "Wallet", value: short(wallet.address), mono: true },
                ]} />
                {savingStep && <p className="mt-4 flex items-center gap-2 text-sm text-primary-ink"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" /> {savingStep}…</p>}
              </Step>}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border px-5 py-4"><Button variant="secondary" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1}>Back</Button>{step < 6 ? <Button onClick={() => setStep((s) => Math.min(6, s + 1))} disabled={!canNext}>Continue <ArrowRight size={14} /></Button> : <Button onClick={create} disabled={!canNext || saving}>{saving ? "Confirming..." : "Sign & Create Automation"}</Button>}</div>
        </motion.div>
      </motion.div>}
    </>
  );
}

/** Shared premium style for selectable chips (asset, cadence, end-mode,
 *  purpose) — consistent selected/hover states across the whole flow. */
function choiceClass(selected: boolean, extra = "") {
  return `rounded-lg border text-sm font-medium transition-all duration-150 ${
    selected
      ? "border-primary/60 bg-primary/10 text-primary-ink shadow-sm shadow-primary/10"
      : "border-border text-foreground hover:border-primary/40 hover:bg-input/50"
  } ${extra}`;
}

function ModeCard({ selected, disabled, onSelect, badge, title, description, pros, note }: {
  selected: boolean; disabled?: boolean; onSelect: () => void; badge: string; title: string; description: string; pros: string[]; note: string;
}) {
  return (
    <button type="button" onClick={onSelect} disabled={disabled}
      className={`group relative flex flex-col rounded-xl border p-5 text-left transition-all duration-200 ${
        disabled ? "cursor-not-allowed border-border opacity-45"
        : selected ? "border-primary/60 bg-primary/[0.06] shadow-lg shadow-primary/10"
        : "border-border hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40"}`}>
      <span aria-hidden className={`absolute right-4 top-4 h-3.5 w-3.5 rounded-full border-2 transition-colors ${selected ? "border-primary bg-primary" : "border-muted-foreground/40 group-hover:border-primary/50"}`} />
      <span className="pr-6 text-base font-semibold tracking-tight text-foreground">{title}</span>
      <span className="mt-2"><Badge tone={badge === "Recommended" ? "primary" : "success"}>{badge}</Badge></span>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{description}</p>
      <ul className="mt-4 space-y-1.5">{pros.map((p) => <li key={p} className="flex items-center gap-2 text-xs text-foreground"><CheckCircle2 size={13} className="shrink-0 text-primary-ink" /> {p}</li>)}</ul>
      <p className="mt-4 text-[11px] leading-snug text-muted-foreground">{note}</p>
    </button>
  );
}

function Step({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return <div><h2 className="text-xl font-semibold text-foreground">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{detail}</p><div className="mt-5">{children}</div></div>;
}

function Verified({ label, value }: { label: string; value: string }) {
  return <div className="mt-3 rounded-lg border border-success/25 bg-success/10 p-3"><div className="flex items-center gap-2 text-sm font-medium text-success"><CheckCircle2 size={15} /> Recipient verified</div><p className="mt-1 text-xs text-muted-foreground">{label}</p><p className="mt-0.5 break-all font-mono text-xs text-foreground">{value}</p></div>;
}
