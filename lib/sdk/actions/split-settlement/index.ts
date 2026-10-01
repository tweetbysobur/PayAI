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
 * ── v2.0.0 input model ───────────────────────────────────────────────────────
 * `recipients` is a list of { recipient, amount } with 2..10 entries (10 is
 * the deployed contract's MAX_RECIPIENTS). Every recipient is a concrete 0x
 * address — names and .nad domains are resolved BEFORE this action, by the
 * intent layer (lib/payees/resolve.ts); this action never resolves anything.
 * Every amount is an exact integer in the token's base units ("units" field
 * type) — no decimal parsing and no floating point anywhere in this file.
 * "The rest" is never an input: the caller computes it and passes a concrete
 * amount. Recipients must be unique (the contract would accept duplicates;
 * PayAI refuses them as almost certainly a mistake).
 *
 * Server-side (reads app config, and for a non-stablecoin token reads its
 * decimals on-chain). Registered by an explicit call to
 * createSplitSettlementProtocol() + registerProtocol() in bootstrap.ts.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { encodeFunctionData, decodeEventLog, formatUnits, getAddress, type Address } from "viem";
import { isAddress } from "@/lib/payees/directory";
import { getChain, getStablecoin } from "@/lib/monad/config";
import { resolveToken } from "@/lib/monad/tokenRegistry";
import { ActionInputError, inputList, inputString } from "@/lib/sdk/types";
import type { Action, ActionInputs, ActionOutflow, ActionQuoteResult, ActionReceipt, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";

const PROTOCOL_ID = "payai-settlement";
const ACTION_ID = "split_payment";
const VERSION = "2.0.0";

/** Fewest recipients a split takes. One recipient is a plain send, which has
 *  its own path; a "split" to one wallet is almost certainly a mistake. */
export const SPLIT_MIN_RECIPIENTS = 2;
/** The deployed SplitSettlement's own MAX_RECIPIENTS (an immutable constant
 *  in contracts/contracts/SplitSettlement.sol). Never above it. */
export const SPLIT_MAX_RECIPIENTS = 10;
const UINT256_MAX = (1n << 256n) - 1n;

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

/** Thrown for a user-input problem (bad/duplicate recipient, bad amount, or an
 *  unusable token). quote()/build() throw it; the routes surface it. */
export class SplitInputError extends ActionInputError {}

interface Pair { recipient: Address; units: bigint }
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

/**
 * Read the validated recipient list into (address, base units) pairs and
 * enforce the cross-item rules Layer A can't express: count bounds, unique
 * recipients, no zero address, never the settlement contract itself, and a
 * total that fits in uint256. Every rejection happens BEFORE any signature —
 * for an ERC-20 split the approval would otherwise already be confirmed when
 * the settlement reverts, leaving a stray allowance and a wasted fee.
 * Defensive re-checks of shape (address, positive integer) are deliberate:
 * this function must be safe even if called on unvalidated inputs.
 */
function collectPairs(inputs: ActionInputs, self?: Address): Pair[] {
  const items = inputList(inputs, "recipients");
  if (items.length < SPLIT_MIN_RECIPIENTS || items.length > SPLIT_MAX_RECIPIENTS) {
    throw new SplitInputError(`A split needs between ${SPLIT_MIN_RECIPIENTS} and ${SPLIT_MAX_RECIPIENTS} recipients.`);
  }
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  let total = 0n;
  items.forEach((item, i) => {
    const r = item.recipient?.trim() ?? "";
    const a = item.amount?.trim() ?? "";
    const n = i + 1;
    if (!isAddress(r)) throw new SplitInputError(`Recipient ${n} is not a valid address.`);
    if (!/^[1-9][0-9]{0,77}$/.test(a)) throw new SplitInputError(`Amount ${n} must be a positive whole number of base units.`);
    const recipient = getAddress(r);
    const key = recipient.toLowerCase();
    if (key === NATIVE) throw new SplitInputError(`Recipient ${n} cannot be the zero address.`);
    if (self && key === self.toLowerCase()) throw new SplitInputError(`Recipient ${n} cannot be the Split Settlement contract itself.`);
    if (seen.has(key)) throw new SplitInputError(`Recipient ${n} appears more than once — each recipient can only be listed once.`);
    seen.add(key);
    const units = BigInt(a);
    total += units;
    if (total > UINT256_MAX) throw new SplitInputError("The split total is too large.");
    pairs.push({ recipient, units });
  });
  return pairs;
}

function splitAction(target: Address, chainId: number): Action {
  return {
    protocolId: PROTOCOL_ID, actionId: ACTION_ID, version: VERSION,
    name: "Split Payment", description: `Split MON or an ERC-20 across ${SPLIT_MIN_RECIPIENTS}–${SPLIT_MAX_RECIPIENTS} recipients in one transaction.`,
    chainId, allowedTargets: [target],
    inputSchema: {
      recipients: {
        type: "list", required: true, minItems: SPLIT_MIN_RECIPIENTS, maxItems: SPLIT_MAX_RECIPIENTS,
        description: "Who receives what: each entry is a 0x address and an exact amount in base units.",
        items: {
          recipient: { type: "address", required: true, description: "Recipient address" },
          amount: { type: "units", required: true, description: "Amount in the token's base units" },
        },
      },
      // Optional: absent/zero-sentinel = native MON; an ERC-20 address = that token.
      token: { type: "token", required: false, description: "Token to split (leave empty for native MON)" },
    },
    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const pairs = collectPairs(inputs, target);
      const ctx = await resolveTokenCtx(inputString(inputs, "token"));
      const units = pairs.map((p) => p.units);
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
      const ctx = await resolveTokenCtx(inputString(inputs, "token"));
      const recipients = pairs.map((p) => p.recipient);
      const amounts = pairs.map((p) => p.units);
      const total = amounts.reduce((a, b) => a + b, 0n);
      const tokenArg = ctx.isNative ? NATIVE : ctx.address;
      // Random per-build correlation ref. It never gates execution on-chain
      // (the contract doesn't check it; replay protection is the tx nonce),
      // but because it is inside the calldata, /api/ask/action/confirm's
      // exact calldata match ties a confirmed transaction to THIS build.
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
    async outflows(inputs: ActionInputs): Promise<readonly ActionOutflow[]> {
      const pairs = collectPairs(inputs, target);
      const ctx = await resolveTokenCtx(inputString(inputs, "token"));
      return pairs.map((p) => ({ recipient: p.recipient, amountUnits: p.units, token: ctx.address, symbol: ctx.symbol, decimals: ctx.decimals }));
    },
    parseResult: (receipt) => parseSplitReceipt(receipt, target),
    async settledOutflows(receipt: ActionReceipt): Promise<readonly ActionOutflow[]> {
      const settled = decodeSettlement(receipt, target);
      if (!settled) return [];
      const ctx = await tokenCtxOrNull(settled.token);
      return settled.recipients.map((r, i) => ({
        recipient: getAddress(r),
        amountUnits: settled.amounts[i] ?? 0n,
        token: getAddress(settled.token),
        symbol: ctx?.symbol ?? "tokens",
        decimals: ctx?.decimals ?? 0,
      }));
    },
  };
}

interface SettledSplit {
  settlementId: bigint; payer: Address; token: Address;
  totalAmount: bigint; recipients: readonly Address[]; amounts: readonly bigint[];
}

/**
 * The CONFIRMED split, from the receipt's own logs. Only a
 * SplitPaymentExecuted event emitted BY the canonical SplitSettlement address
 * counts (§14) — an event from any other address is ignored, so a look-alike
 * log can never masquerade as a confirmed settlement. Null when the receipt
 * reverted or carries no canonical event. Never throws.
 */
function decodeSettlement(receipt: ActionReceipt, canonical: Address): SettledSplit | null {
  if (receipt.status !== "success") return null;
  const canon = canonical.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== canon) continue; // must be OUR contract
    try {
      const decoded = decodeEventLog({ abi: SPLIT_ABI, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data });
      if (decoded.eventName !== "SplitPaymentExecuted") continue;
      return decoded.args as unknown as SettledSplit;
    } catch { /* not our event shape — keep scanning */ }
  }
  return null;
}

/** Token decimals/symbol for display, without ever throwing. */
async function tokenCtxOrNull(token: Address): Promise<TokenCtx | null> {
  try {
    return await resolveTokenCtx(token);
  } catch {
    return null;
  }
}

/**
 * Display fields for the confirmed split. Amounts are formatted with the
 * token's real decimals when they can be read; otherwise shown in base units,
 * labelled as such — never guessed. A receipt with no canonical event reports
 * only its status, never a fabricated result.
 */
async function parseSplitReceipt(receipt: ActionReceipt, canonical: Address): Promise<Readonly<Record<string, string>>> {
  const settled = decodeSettlement(receipt, canonical);
  if (!settled) return { status: receipt.status };
  const ctx = await tokenCtxOrNull(settled.token);
  const fmt = (u: bigint | undefined) =>
    u == null ? "" : ctx ? `${formatUnits(u, ctx.decimals)} ${ctx.symbol}` : `${u.toString()} base units`;
  const out: Record<string, string> = {
    status: receipt.status,
    settlementId: settled.settlementId.toString(),
    payer: settled.payer,
    token: ctx ? (ctx.isNative ? "MON (native)" : `${ctx.symbol} (${settled.token})`) : settled.token,
    recipientCount: String(settled.recipients.length),
    total: fmt(settled.totalAmount),
  };
  settled.recipients.forEach((r, i) => {
    out[`recipient ${i + 1}`] = r;
    out[`amount ${i + 1}`] = fmt(settled.amounts[i]);
  });
  return out;
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
