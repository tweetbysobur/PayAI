/**
 * Second real PayAI SDK action: split_payment — atomically send the user's own
 * native MON to several recipients in one transaction, through PayAI's own
 * SplitSettlement contract (audited Solidity commit 4520723; deployed,
 * Sourcify-verified, and smoke-tested on Monad mainnet — see
 * contracts/LIVE_CONTRACTS.md).
 *
 * Canonical, immutable mainnet target — explicit and centralized here, the
 * ONE place the SDK knows about it:
 *   0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F  (chain 143)
 * The orphan first deploy (0xfCD2…57dd) is deliberately absent and must never
 * be added.
 *
 * ── Native MON only in v1 (deliberate, not an oversight) ─────────────────────
 * The deployed contract also handles ERC-20 splits, but an ERC-20 split needs
 * an `approve(SplitSettlement, total)` step whose transaction target is the
 * TOKEN contract. Layer B's hard invariant (lib/sdk/validate.ts) requires every
 * step's tx.to to be in the action's frozen allowlist, and the Phase 5 brief
 * §10 is explicit: "Do not allow the token address to become the transaction
 * target." Those two rules make an in-allowlist ERC-20 approve step impossible
 * without weakening Layer B — which the brief forbids. So v1 is native-only:
 * every step targets ONLY the canonical SplitSettlement, Layer B stays intact,
 * and a non-native `token` input is rejected cleanly rather than silently
 * routed around the boundary. ERC-20 split is a later version gated on a
 * deliberate Layer-B extension (validate an approve step's decoded spender),
 * not a same-phase workaround.
 *
 * Server-side (reads app config). Registered by an explicit call to
 * createSplitSettlementProtocol() + registerProtocol() in bootstrap.ts — never
 * auto-registered at import.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { encodeFunctionData, decodeEventLog, formatEther, parseEther, getAddress, type Address } from "viem";
import { isAddress } from "@/lib/payees/directory";
import { getChain } from "@/lib/monad/config";
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

/** Exactly the one function we encode plus the one event we decode — no other
 *  contract surface is introduced. Matches the audited SplitSettlement ABI. */
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

/** Thrown for a user-input problem (missing/mismatched pair, non-native token).
 *  quote()/build() throw it; the routes surface it as a failed preparation. */
export class SplitInputError extends Error {}

interface Pair { recipient: Address; amount: string }

/** Native-only guard: v1 accepts native MON (absent token, or the zero
 *  sentinel) and rejects any real ERC-20 with a clear reason (see the header). */
function assertNativeToken(inputs: ActionInputs): void {
  const token = inputs.token?.trim();
  if (token && token.toLowerCase() !== NATIVE) {
    throw new SplitInputError(
      "This version splits native MON only. ERC-20 split isn't enabled yet — leave the token empty to split MON.",
    );
  }
}

/**
 * Collect the recipient/amount pairs from the bounded scalar fields, enforcing
 * that each optional recipient has a matching amount and vice-versa. Pure input
 * shaping — no address/amount value checks here (Layer A already ran those on
 * each field); this only enforces the CROSS-field pairing Layer A can't express.
 */
function collectPairs(inputs: ActionInputs): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 1; i <= SDK_MAX_RECIPIENTS; i++) {
    const r = inputs[`recipient${i}`]?.trim();
    const a = inputs[`amount${i}`]?.trim();
    if (!r && !a) continue;
    if (r && !a) throw new SplitInputError(`recipient${i} is missing a matching amount${i}.`);
    if (a && !r) throw new SplitInputError(`amount${i} is missing a matching recipient${i}.`);
    if (!isAddress(r as string)) throw new SplitInputError(`recipient${i} is not a valid address.`);
    pairs.push({ recipient: getAddress(r as string), amount: a as string });
  }
  if (pairs.length === 0) throw new SplitInputError("At least one recipient and amount are required.");
  return pairs;
}

/** Sum of the pair amounts in wei (native, 18 decimals). parseEther rejects a
 *  malformed/exponential amount, so a bad value fails closed here. */
function totalWei(pairs: Pair[]): bigint {
  return pairs.reduce((acc, p) => acc + parseEther(p.amount), 0n);
}

function splitAction(target: Address, chainId: number): Action {
  const amountField = { type: "amount", required: false, description: "Amount of MON", decimals: 18 } as const;
  const addrField = (n: number, req: boolean) => ({ type: "address", required: req, description: `Recipient ${n} address` } as const);

  return {
    protocolId: PROTOCOL_ID, actionId: ACTION_ID, version: VERSION,
    name: "Split Payment", description: "Split native MON across up to 3 recipients in one transaction.",
    chainId, allowedTargets: [target],
    inputSchema: {
      recipient1: addrField(1, true),
      amount1: { ...amountField, required: true, description: "Amount of MON to recipient 1" },
      recipient2: addrField(2, false),
      amount2: { ...amountField, description: "Amount of MON to recipient 2" },
      recipient3: addrField(3, false),
      amount3: { ...amountField, description: "Amount of MON to recipient 3" },
      // Optional, native-only in v1 (see assertNativeToken). Present so the
      // schema matches the eventual ERC-20 surface without accepting it yet.
      token: { type: "token", required: false, description: "Token to split (leave empty for native MON)" },
    },
    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      assertNativeToken(inputs);
      const pairs = collectPairs(inputs);
      const total = formatEther(totalWei(pairs));
      const details: Record<string, string> = {
        recipients: String(pairs.length),
        total: `${total} MON`,
      };
      pairs.forEach((p, i) => {
        details[`recipient ${i + 1}`] = p.recipient;
        details[`amount ${i + 1}`] = `${p.amount} MON`;
      });
      return {
        summary: `Split ${total} MON between ${pairs.length} recipient${pairs.length === 1 ? "" : "s"}`,
        details,
        quotedAt: Date.now(),
      };
    },
    async build(inputs: ActionInputs): Promise<UnsignedActionStep[]> {
      assertNativeToken(inputs);
      const pairs = collectPairs(inputs);
      const recipients = pairs.map((p) => p.recipient);
      const amounts = pairs.map((p) => parseEther(p.amount));
      const total = amounts.reduce((a, b) => a + b, 0n);
      // Opaque correlation ref — NO security meaning, never gates execution
      // (the contract has no requestId; replay is the tx nonce). Random so two
      // otherwise-identical splits are still distinguishable in logs.
      const ref = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      return [{
        kind: "action",
        label: `Split ${formatEther(total)} MON to ${pairs.length} recipient${pairs.length === 1 ? "" : "s"}`,
        tx: {
          to: target,
          data: encodeFunctionData({ abi: SPLIT_ABI, functionName: "splitPayment", args: [NATIVE, recipients, amounts, ref] }),
          value: total.toString(),
        },
      }];
    },
    parseResult: (receipt) => parseSplitReceipt(receipt, target),
  };
}

/**
 * Decode the CONFIRMED split from the receipt's own logs. Only a
 * SplitPaymentExecuted event emitted BY the canonical SplitSettlement address
 * counts (§12) — an event from any other address is ignored, so a look-alike
 * log can never masquerade as a confirmed settlement. Never throws: a receipt
 * with no matching event reports only its status, never a fabricated result.
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
      const unit = isNative ? "MON" : "tokens";
      const out: Record<string, string> = {
        status: receipt.status,
        settlementId: args.settlementId.toString(),
        payer: args.payer,
        token: isNative ? "MON (native)" : args.token,
        recipientCount: String(args.recipients.length),
        total: isNative ? `${formatEther(args.totalAmount)} ${unit}` : args.totalAmount.toString(),
      };
      args.recipients.forEach((r, i) => {
        out[`recipient ${i + 1}`] = r;
        const amt = args.amounts[i];
        out[`amount ${i + 1}`] = isNative && amt != null ? `${formatEther(amt)} MON` : String(amt ?? "");
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
