/**
 * Second real PayAI SDK action: split_payment — atomically send the user's own
 * funds (native MON or an ERC-20) to several recipients in one settlement,
 * through PayAI's own SplitSettlement contract (audited Solidity commit
 * 4520723; deployed, Sourcify-verified, and smoke-tested on Monad mainnet —
 * see contracts/LIVE_CONTRACTS.md).
 *
 * Canonical, immutable mainnet target — explicit and centralized here, the
 * ONE place the SDK knows about it:
 *   0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F  (chain 143)
 * The orphan first deploy (0xfCD2…57dd) is deliberately absent and must never
 * be added.
 *
 * ── Native MON and ERC-20 (Phase 5B) ─────────────────────────────────────────
 * Native: one action step to the canonical contract, value == exact total.
 * ERC-20: an approve(token → spender=canonical, amount=exact total) step FIRST,
 * then the splitPayment(token, recipients[], amounts[], ref) step to the
 * canonical contract. The approve step's transaction target is the user's
 * TOKEN (an arbitrary address), never the settlement target — and it carries a
 * typed `approval` declaration that Layer B decodes and validates
 * (lib/sdk/validate.ts's validateApprovalStep): the allowance can only ever go
 * to the canonical, allowlisted contract, for the EXACT total, via exactly
 * approve(address,uint256) and nothing else. build() asserts
 * approval.amount === sum(amounts) so the approval can never diverge from what
 * the settlement will actually spend. The settlement transaction itself always
 * targets ONLY the canonical contract (normal Layer B).
 *
 * The token is a USER-SELECTED asset, not an execution target: security comes
 * entirely from the fixed spender + fixed settlement target, never from
 * trusting the token. The deployed contract already enforces exact-delivery /
 * fee-on-transfer rejection / atomicity on-chain; nothing here changes that.
 *
 * Server-side (reads app config, and for a non-stablecoin token reads its
 * decimals on-chain). Registered by an explicit call to
 * createSplitSettlementProtocol() + registerProtocol() in bootstrap.ts.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { encodeFunctionData, decodeEventLog, formatUnits, parseUnits, getAddress, type Address } from "viem";
import { isAddress } from "@/lib/payees/directory";
import { getChain, getStablecoin } from "@/lib/monad/config";
import { resolveToken } from "@/lib/monad/tokenRegistry";
import type { Action, ActionInputs, ActionQuoteResult, ActionReceipt, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";

const PROTOCOL_ID = "payai-settlement";
const ACTION_ID = "split_payment";
const VERSION = "1.0.0";

/** How many named scalar recipient/amount pairs the v1 SDK schema exposes.
 *  The contract's own cap is 10; the SDK surfaces the first 3 as bounded
 *  scalar fields (the current ActionInputField set has no array type). */
const SDK_MAX_RECIPIENTS = 3;

const NATIVE = "0x0000000000000000000000000000000000000000" as const;

/** Canonical, immutable SplitSettlement deployment, keyed by chain id. The one
 *  place this address lives. Mainnet (143) only — the contract is not deployed
 *  anywhere else, so the action registers only where an address exists. */
const CANONICAL_ADDRESS: Readonly<Record<number, Address>> = {
  143: "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F",
};

/** splitPayment + its event (encode/decode), and the exact ERC-20 approve we
 *  build. No other contract surface is introduced. Matches the audited ABI. */
const SPLIT_ABI = [
  {
    type: "function", name: "splitPayment", stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" }, { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" },
    ],
    outputs: [{ name: "settlementId", type: "uint256" }],
  },
  {
    type: "event", name: "SplitPaymentExecuted",
    inputs: [
      { name: "settlementId", type: "uint256", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "ref", type: "bytes32", indexed: false },
      { name: "totalAmount", type: "uint256", indexed: false },
      { name: "recipients", type: "address[]", indexed: false },
      { name: "amounts", type: "uint256[]", indexed: false },
    ],
  },
] as const;

const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** Thrown for a user-input problem (missing/mismatched pair, bad amount, or an
 *  unusable token). quote()/build() throw it; the routes surface it. */
export class SplitInputError extends Error {}

interface Pair { recipient: Address; amount: string }
interface TokenCtx { isNative: boolean; address: Address; decimals: number; symbol: string }

/**
 * Resolve the split token to (address, decimals, symbol). Native (absent token
 * or the zero sentinel) is 18-decimal MON. An ERC-20 is validated as an
 * address; the configured stablecoin resolves from config (no chain read),
 * anything else via the app's existing on-chain token resolver (no second
 * registry). A token that can't be read as an ERC-20 fails closed.
 */
async function resolveTokenCtx(tokenInput?: string): Promise<TokenCtx> {
  const t = tokenInput?.trim();
  if (!t || t.toLowerCase() === NATIVE) return { isNative: true, address: NATIVE, decimals: 18, symbol: "MON" };
  if (!isAddress(t)) throw new SplitInputError(`"${t}" is not a valid token address.`);
  try {
    const usdc = getStablecoin();
    if (t.toLowerCase() === usdc.address.toLowerCase()) return { isNative: false, address: getAddress(t), decimals: usdc.decimals, symbol: usdc.symbol };
  } catch { /* stablecoin unconfigured — fall through to on-chain resolution */ }
  let info;
  try {
    info = await resolveToken(t);
  } catch {
    throw new SplitInputError(`Couldn't read "${t}" as an ERC-20 token on Monad.`);
  }
  return { isNative: false, address: getAddress(t), decimals: info.decimals, symbol: info.symbol };
}

/** Amount → base units at the token's decimals, rejecting a value that rounds
 *  to zero (below the token's smallest unit) — the per-token equivalent of
 *  Layer A's amount floor, done here where the real decimals are known. */
function toUnits(amount: string, decimals: number): bigint {
  let units: bigint;
  try {
    units = parseUnits(amount, decimals);
  } catch {
    throw new SplitInputError(`"${amount}" is not a valid amount.`);
  }
  if (units <= 0n) throw new SplitInputError(`"${amount}" is below the smallest unit of this token.`);
  return units;
}

/**
 * Collect the recipient/amount pairs from the bounded scalar fields, enforcing
 * that each optional recipient has a matching amount and vice-versa (the
 * CROSS-field pairing Layer A can't express). Value checks on each individual
 * field already ran in Layer A.
 */
function collectPairs(inputs: ActionInputs, self?: Address): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 1; i <= SDK_MAX_RECIPIENTS; i++) {
    const r = inputs[`recipient${i}`]?.trim();
    const a = inputs[`amount${i}`]?.trim();
    if (!r && !a) continue;
    if (r && !a) throw new SplitInputError(`recipient${i} is missing a matching amount${i}.`);
    if (a && !r) throw new SplitInputError(`amount${i} is missing a matching recipient${i}.`);
    if (!isAddress(r as string)) throw new SplitInputError(`recipient${i} is not a valid address.`);
    const recipient = getAddress(r as string);
    // The contract reverts on these (zero recipient / self recipient). Reject
    // them BEFORE any signature: for an ERC-20 split the approval would
    // otherwise already be signed and confirmed when the split reverts,
    // leaving a stray allowance and a wasted approval fee.
    if (recipient.toLowerCase() === NATIVE) throw new SplitInputError(`recipient${i} cannot be the zero address.`);
    if (self && recipient.toLowerCase() === self.toLowerCase()) throw new SplitInputError(`recipient${i} cannot be the Split Settlement contract itself.`);
    pairs.push({ recipient, amount: a as string });
  }
  if (pairs.length === 0) throw new SplitInputError("At least one recipient and amount are required.");
  return pairs;
}

function splitAction(target: Address, chainId: number): Action {
  const amountField = { type: "amount", required: false, description: "Amount" } as const;
  const addrField = (n: number, req: boolean) => ({ type: "address", required: req, description: `Recipient ${n} address` } as const);

  return {
    protocolId: PROTOCOL_ID, actionId: ACTION_ID, version: VERSION,
    name: "Split Payment", description: "Split MON or an ERC-20 across up to 3 recipients in one transaction.",
    chainId, allowedTargets: [target],
    inputSchema: {
      recipient1: addrField(1, true),
      amount1: { ...amountField, required: true, description: "Amount to recipient 1" },
      recipient2: addrField(2, false),
      amount2: { ...amountField, description: "Amount to recipient 2" },
      recipient3: addrField(3, false),
      amount3: { ...amountField, description: "Amount to recipient 3" },
      // Optional: absent/zero-sentinel = native MON; an ERC-20 address = that token.
      token: { type: "token", required: false, description: "Token to split (leave empty for native MON)" },
    },
    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const pairs = collectPairs(inputs, target);
      const ctx = await resolveTokenCtx(inputs.token);
      const units = pairs.map((p) => toUnits(p.amount, ctx.decimals));
      const total = units.reduce((a, b) => a + b, 0n);
      const fmt = (u: bigint) => formatUnits(u, ctx.decimals);
      const details: Record<string, string> = {
        token: ctx.isNative ? "MON (native)" : `${ctx.symbol} (${ctx.address})`,
        recipients: String(pairs.length),
        total: `${fmt(total)} ${ctx.symbol}`,
      };
      pairs.forEach((p, i) => {
        details[`recipient ${i + 1}`] = p.recipient;
        details[`amount ${i + 1}`] = `${fmt(units[i])} ${ctx.symbol}`;
      });
      return {
        summary: `Split ${fmt(total)} ${ctx.symbol} between ${pairs.length} recipient${pairs.length === 1 ? "" : "s"}`,
        details,
        quotedAt: Date.now(),
      };
    },
    async build(inputs: ActionInputs): Promise<UnsignedActionStep[]> {
      const pairs = collectPairs(inputs, target);
      const ctx = await resolveTokenCtx(inputs.token);
      const recipients = pairs.map((p) => p.recipient);
      const amounts = pairs.map((p) => toUnits(p.amount, ctx.decimals));
      const total = amounts.reduce((a, b) => a + b, 0n);
      const tokenArg = ctx.isNative ? NATIVE : ctx.address;
      // Opaque correlation ref — NO security meaning, never gates execution
      // (the contract has no requestId; replay is the tx nonce).
      const ref = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      const fmt = (u: bigint) => formatUnits(u, ctx.decimals);

      const steps: UnsignedActionStep[] = [];

      if (!ctx.isNative) {
        // MANDATORY (Phase 5B §8): the allowance is EXACTLY the settlement
        // total — never more, never unlimited. Asserted here so a future edit
        // can't silently let approval and settlement diverge; Layer B
        // independently re-checks the decoded calldata against this same value.
        const approveAmount = total;
        if (approveAmount !== amounts.reduce((a, b) => a + b, 0n)) {
          throw new Error("split_payment: approval amount must equal the sum of recipient amounts.");
        }
        steps.push({
          kind: "approve",
          label: `Approve ${fmt(approveAmount)} ${ctx.symbol} for PayAI Split Settlement`,
          tx: {
            to: ctx.address,
            data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [target, approveAmount] }),
            value: "0",
          },
          approval: { token: ctx.address, spender: target, amount: approveAmount.toString() },
        });
      }

      steps.push({
        kind: "action",
        label: `Split ${fmt(total)} ${ctx.symbol} to ${pairs.length} recipient${pairs.length === 1 ? "" : "s"}`,
        tx: {
          to: target,
          data: encodeFunctionData({ abi: SPLIT_ABI, functionName: "splitPayment", args: [tokenArg, recipients, amounts, ref] }),
          value: ctx.isNative ? total.toString() : "0",
        },
      });
      return steps;
    },
    parseResult: (receipt) => parseSplitReceipt(receipt, target),
  };
}

/**
 * Decode the CONFIRMED split from the receipt's own logs. Only a
 * SplitPaymentExecuted event emitted BY the canonical SplitSettlement address
 * counts (§14) — an event from any other address is ignored, so a look-alike
 * log can never masquerade as a confirmed settlement. Never throws: a receipt
 * with no matching event reports only its status, never a fabricated result.
 * ERC-20 amounts are reported in base units (the receipt alone doesn't carry
 * token decimals, and this stays a pure, non-throwing reader).
 */
async function parseSplitReceipt(receipt: ActionReceipt, canonical: Address): Promise<Readonly<Record<string, string>>> {
  const base: Record<string, string> = { status: receipt.status };
  if (receipt.status !== "success") return base;
  const canon = canonical.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== canon) continue; // must be OUR contract
    try {
      const decoded = decodeEventLog({ abi: SPLIT_ABI, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data });
      if (decoded.eventName !== "SplitPaymentExecuted") continue;
      const args = decoded.args as unknown as {
        settlementId: bigint; payer: Address; token: Address; totalAmount: bigint;
        recipients: readonly Address[]; amounts: readonly bigint[];
      };
      const isNative = args.token.toLowerCase() === NATIVE;
      const out: Record<string, string> = {
        status: receipt.status,
        settlementId: args.settlementId.toString(),
        payer: args.payer,
        token: isNative ? "MON (native)" : args.token,
        recipientCount: String(args.recipients.length),
        total: isNative ? `${formatUnits(args.totalAmount, 18)} MON` : args.totalAmount.toString(),
      };
      args.recipients.forEach((r, i) => {
        out[`recipient ${i + 1}`] = r;
        const amt = args.amounts[i];
        out[`amount ${i + 1}`] = isNative && amt != null ? `${formatUnits(amt, 18)} MON` : String(amt ?? "");
      });
      return out;
    } catch { /* not our event shape — keep scanning */ }
  }
  return base; // success, but no canonical settlement event: report nothing invented
}

/**
 * Build the SplitSettlement protocol adapter from the active chain. Returns
 * null on any chain where the contract isn't deployed (everything but Monad
 * mainnet), so the caller registers nothing rather than pinning an action to a
 * missing target — same discipline as createWmonProtocol().
 */
export function createSplitSettlementProtocol(): ProtocolAdapter | null {
  const chainId = getChain().id;
  const target = CANONICAL_ADDRESS[chainId];
  if (!target) return null;
  return {
    protocolId: PROTOCOL_ID,
    name: "PayAI Split Settlement",
    chainId,
    docsUrl: "https://usepayai.xyz",
    allowedTargets: [target],
    actions: [splitAction(target, chainId)],
  };
}
