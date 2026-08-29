import { keccak256, stringToHex, type Hex } from "viem";
import type { WalletState } from "@/lib/wallet/useWallet";
import type { TemplateCategory } from "@/lib/automation/templates";

/**
 * Shared automation types, helpers, and small presentational atoms used by
 * BOTH the standalone Automations page (app/dashboard/automations/page.tsx)
 * AND the in-chat AutomationCreator modal (components/dashboard/AutomationCreator.tsx).
 *
 * Everything here was extracted VERBATIM from the automations page when the
 * creator was made reusable — same logic, same wire formats. signatureMessage
 * in particular MUST stay byte-for-byte identical to the server's, or
 * verifyMessage() rejects every creation; it is moved, not modified.
 */

export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

export type FundingMode = "wallet" | "reserved";
export type OnchainConfig = {
  chainId: number; executor: string | null; vault: string | null; wmon: string | null;
  usdc: { address: string; decimals: number }; walletModeAvailable: boolean; reservedModeAvailable: boolean;
};

export const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** bytes32 automation id — must match the server's requestId32 (keccak of the id string). */
export function autoId32(id: string): Hex {
  return keccak256(stringToHex(id));
}

/**
 * Client-side ledger of reservation ids whose automation may not have been
 * saved yet.
 *
 * Reserved Funds moves money in the browser BEFORE the record is created
 * server-side, and the id is generated in the tab. Without writing it down
 * first, a create that fails after the reserve tx leaves funds in the vault
 * with no handle anywhere — the failure that already stranded 400 MON.
 *
 * localStorage is not a real database, and this is not a substitute for the
 * proper fix (reserve should not precede a durable record). It is a cheap
 * safety net that survives the common cases: a reload, a failed POST, a
 * validation rejection. Scoped by wallet so one browser with several wallets
 * doesn't offer one wallet's reservation to another — refund() would reject
 * it on-chain anyway, but showing it would be misleading.
 */
export const PENDING_KEY = "payai_pending_reservations";
export type PendingReservation = { id: string; wallet: string; at: number };

export function readPendingReservations(): PendingReservation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as PendingReservation[]).filter((p) => p && typeof p.id === "string") : [];
  } catch { return []; }
}

export function rememberPendingReservation(id: string, wallet: string | null) {
  if (typeof window === "undefined" || !wallet) return;
  try {
    const next = [{ id, wallet: wallet.toLowerCase(), at: Date.now() }, ...readPendingReservations().filter((p) => p.id !== id)];
    localStorage.setItem(PENDING_KEY, JSON.stringify(next.slice(0, 25)));
  } catch { /* storage unavailable — the recovery-by-tx-hash path still works */ }
}

export function forgetPendingReservation(id: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(readPendingReservations().filter((p) => p.id !== id)));
  } catch { /* ignore */ }
}

/**
 * Send a tx and wait for it to confirm through the wallet the user actually
 * connected with (wallet.sendTransaction/waitForReceipt), not the raw
 * `window.ethereum` global — with multiple wallet extensions installed,
 * `window.ethereum` can silently be a DIFFERENT extension than the one the
 * user picked, sending the tx to the wrong (or a disconnected) wallet. Wait
 * uses PayAI's own RPC via viem rather than the wallet's, so it doesn't
 * depend on that extension supporting eth_getTransactionReceipt correctly.
 */
export async function confirmTx(wallet: WalletState, to: string, data: string, value?: bigint): Promise<string> {
  const hash = await wallet.sendTransaction({ to, data, value: value != null ? `0x${value.toString(16)}` : undefined });
  const receipt = (await wallet.waitForReceipt(hash)) as { status?: string } | null;
  if (receipt && receipt.status !== "success") throw new Error("The on-chain transaction failed. Nothing was created.");
  return hash;
}

export type Cadence = "once" | "daily" | "weekly" | "monthly" | "custom";
export type Status = "active" | "paused" | "completed" | "cancelled" | "failed" | "scheduled" | "executing";
export type IntervalUnit = "days" | "weeks" | "months";
export type BulkRecipientResult = { address: string; domain?: string | null; amount: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string; durationMs?: number };
export type Run = { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string; gasFee?: number; durationMs?: number; recipientResults?: BulkRecipientResult[] };
export type EndCondition = { type: "never" } | { type: "after_count"; totalRuns: number } | { type: "until_date"; untilMs: number };
export type EndMode = "never" | "after_count" | "until_date";
export type BulkRecipient = { input: string; address: string; domain?: string | null; amount: number; note?: string };
export type Automation = {
  id: string; amount: number; token: string; tokenAddress?: string; tokenDecimals?: number; tokenLogo?: string | null;
  recipient: string; domain?: string | null;
  cadence: Cadence; intervalCount?: number; intervalUnit?: IntervalUnit; nextRun: number; status: Status;
  createdAt: number; modifiedAt?: number | null; runs: Run[]; purpose?: string; memo?: string; timezone?: string; runsCompleted: number; failureCount: number; lastError?: string | null; sender?: string | null;
  endCondition?: EndCondition; fundingMode?: "wallet" | "reserved";
  /** The exact PaymentExecutor this automation's ERC-20 approval was granted
   *  to, stamped at creation — may differ from the currently configured
   *  executor after a contract redeploy. Absent on automations created before
   *  this existed, which really were approved against whatever is current. */
  executorAddress?: string | null;
  /** Set once a refund (agent-triggered or self-reported) actually lands —
   *  kept for back-compat with anything still reading this field directly;
   *  refundHistory below is the source of truth. */
  reserveRefundTxHash?: string | null;
  /** Explicit refund outcome — see PaymentAutomation.reserveRefundStatus in
   *  lib/platform/types.ts for why this exists instead of just checking
   *  reserveRefundTxHash: "undefined"/absent must never be read as "nothing
   *  owed," only as "this concept predates the row." */
  reserveRefundStatus?: "none" | "refunded" | "pending";
  refundHistory?: {
    reason: string; amount: number; txHash: string; explorerUrl?: string;
    at: number; automationId: string; originalExecutionAt?: number | null;
  }[];
  templateId?: string | null; templateCategory?: string | null;
  /** Bulk Payments only — presence marks this as a multi-recipient automation. */
  recipients?: BulkRecipient[];
  distributionMethod?: "equal" | "fixed" | "percentage" | "custom";
};

export const PURPOSES = ["Savings", "Salary", "Subscription", "Investment", "Rent", "Family", "Utilities", "Gift", "Business", "Other"];

export const short = (s?: string | null) => (s ? `${s.slice(0, 6)}...${s.slice(-4)}` : "-");
export const money = (n: number, token = "") => `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}${token ? ` ${token}` : ""}`;

export function cadenceLabel(a: Pick<Automation, "cadence" | "intervalCount" | "intervalUnit">) {
  if (a.cadence === "once") return "One time";
  if (a.cadence === "daily") return "Daily";
  if (a.cadence === "weekly") return "Weekly";
  if (a.cadence === "monthly") return "Monthly";
  return `Every ${a.intervalCount ?? 1} ${a.intervalUnit ?? "days"}`;
}

export function annualVolume(a: Automation) {
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

/** Advance a timestamp by one cadence step — mirrors the server's advanceRun. */
export function stepOnce(from: number, cadence: Cadence, intervalCount: number, intervalUnit: IntervalUnit): number {
  const d = new Date(from);
  const n = Math.max(1, intervalCount);
  if (cadence === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "custom") {
    if (intervalUnit === "weeks") d.setUTCDate(d.getUTCDate() + n * 7);
    else if (intervalUnit === "months") d.setUTCMonth(d.getUTCMonth() + n);
    else d.setUTCDate(d.getUTCDate() + n);
  }
  return d.getTime();
}

/** How many payments this schedule will make. Returns null for open-ended
 *  ("no end date") automations, where the total is genuinely unbounded. */
export function countOccurrences(opts: {
  startAt: number; cadence: Cadence; intervalCount: number; intervalUnit: IntervalUnit;
  endMode: EndMode; endCount: number; endUntilMs: number;
}): number | null {
  if (opts.cadence === "once") return 1;
  if (opts.endMode === "after_count") return Math.max(1, Math.floor(opts.endCount) || 1);
  if (opts.endMode === "until_date") {
    if (!Number.isFinite(opts.endUntilMs) || opts.endUntilMs < opts.startAt) return 0;
    let n = 0; let t = opts.startAt; const CAP = 1000;
    while (t <= opts.endUntilMs && n < CAP) { n++; t = stepOnce(t, opts.cadence, opts.intervalCount, opts.intervalUnit); }
    return n;
  }
  return null; // never — open-ended
}

export function signatureMessage(input: { walletAddress: string; recipient: string; amount: number; token: string; cadence: string; startAt: number; timezone: string; purpose: string }) {
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

export type AutomationSeed = Partial<Pick<Automation, "domain" | "recipient" | "token" | "tokenAddress" | "tokenDecimals" | "tokenLogo" | "amount" | "cadence" | "intervalCount" | "intervalUnit" | "nextRun" | "purpose" | "memo">> & {
  /** Only set when seeded from an Automation Template — carried through to
   *  creation so the created automation records which template it came from.
   *  A real Duplicate or an AI-parsed draft never sets these. */
  fundingMode?: FundingMode;
  endMode?: EndMode;
  templateId?: string;
  templateCategory?: TemplateCategory;
};

export function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><p className="text-muted-foreground">{label}</p><p className={`mt-0.5 truncate text-foreground ${mono ? "font-mono" : ""}`}>{value}</p></div>;
}

/** Sleek review summary — each field a subtle panel card; key money values
 *  accented in purple so the numbers pop against white text. */
export function ReviewGrid({ rows }: { rows: { label: string; value: string; mono?: boolean; accent?: boolean }[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.label} className="min-w-0 rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-3.5 py-2.5 transition-colors hover:border-primary/25">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{r.label}</p>
          <p className={`mt-0.5 truncate ${r.mono ? "font-mono text-xs" : "text-sm"} ${r.accent ? "font-semibold text-primary-ink" : "font-medium text-foreground"}`}>{r.value}</p>
        </div>
      ))}
    </div>
  );
}
