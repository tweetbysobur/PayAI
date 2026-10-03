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
 * `recipients` is a list of { recipient, amount } with 2..9 entries. The
 * deployed contract's MAX_RECIPIENTS is 10; the 10th slot is reserved for the
 * PayAI platform fee leg (see "Platform fee" below). Every recipient is a concrete 0x
 * address — names and .nad domains are resolved BEFORE this action, by the
 * intent layer (lib/payees/resolve.ts); this action never resolves anything.
 * Every amount is an exact integer in the token's base units ("units" field
 * type) — no decimal parsing and no floating point anywhere in this file.
 * "The rest" is never an input: the caller computes it and passes a concrete
 * amount. Recipients must be unique (the contract would accept duplicates;
 * PayAI refuses them as almost certainly a mistake).
 *
 * ── Platform fee ─────────────────────────────────────────────────────────────
 * PayAI's standard platform fee, charged ON TOP of the recipients' exact
 * amounts: fee = floor(recipientTotal * feeBps / 10000), with feeBps and the
 * treasury read live from the chain (./fee.ts). The fee is ONE extra leg —
 * { treasury, fee } — appended to the same splitPayment call, so the whole
 * payment (recipients + fee) settles atomically in one transaction; no
 * contract change. A fee that floors to 0 adds no leg (the contract rejects
 * zero amounts). quote() returns the fee terms; build() reproduces them
 * exactly or refuses, and the routes refuse a build whose terms moved since
 * the preview. The treasury can never be named as a user recipient, so the
 * confirmed result can always tell the fee leg apart.
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
import type {
  Action, ActionInputs, ActionOutflow, ActionQuoteResult, ActionReceipt, ActionResultContext, ProtocolAdapter, SettledOutflows, UnsignedActionStep,
} from "@/lib/sdk/types";
import { readSplitFeeTerms, splitPlatformFee, type SplitFeeTerms } from "./fee";

const PROTOCOL_ID = "payai-settlement";
const ACTION_ID = "split_payment";
const VERSION = "2.0.0";

/** Fewest recipients a split takes. One recipient is a plain send, which has
 *  its own path; a "split" to one wallet is almost certainly a mistake. */
export const SPLIT_MIN_RECIPIENTS = 2;
/** The deployed SplitSettlement's own MAX_RECIPIENTS (an immutable constant
 *  in contracts/contracts/SplitSettlement.sol) — every leg, fee included. */
export const SPLIT_CONTRACT_MAX_LEGS = 10;
/** Most USER recipients a split takes: the contract's limit minus the one
 *  slot reserved for the platform fee leg. Applied always — even on a split
 *  whose fee happens to floor to zero — so the limit a user sees never
 *  depends on the amount. */
export const SPLIT_MAX_RECIPIENTS = SPLIT_CONTRACT_MAX_LEGS - 1;
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
function collectPairs(inputs: ActionInputs, self?: Address, treasury?: Address): Pair[] {
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
    if (treasury && key === treasury.toLowerCase()) throw new SplitInputError(`Recipient ${n} is PayAI's fee treasury, which can't be a split recipient.`);
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
    // The platform fee is charged on top of the recipients' amounts (see
    // "Platform fee" above). Metadata only — quote/build are unchanged.
    feePolicy: { mode: "on_top" },
    // What a confirmed split produces (decoded from SplitPaymentExecuted).
    // Declarations only — nothing here changes how a split executes.
    outputs: {
      recipientAmounts: { type: "units[]", description: "The exact amount each recipient received", denominatedIn: { input: "token" } },
      fee: { type: "units", description: "The PayAI platform fee paid to the treasury", denominatedIn: { input: "token" } },
      gross: { type: "units", description: "Recipients total plus the platform fee", denominatedIn: { input: "token" } },
    },
    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const fee = await readSplitFeeTerms();
      const pairs = collectPairs(inputs, target, fee.treasury);
      const ctx = await resolveTokenCtx(inputString(inputs, "token"));
      const priced = priceSplit(pairs, fee);
      const fmt = (u: bigint) => `${formatUnits(u, ctx.decimals)} ${ctx.symbol}`;
      const details: Record<string, string> = {
        token: ctx.isNative ? "MON (native)" : `${ctx.symbol} (${ctx.address})`,
        recipients: String(pairs.length),
        total: fmt(priced.recipientTotal),
      };
      pairs.forEach((p, i) => {
        details[`recipient ${i + 1}`] = p.recipient;
        details[`amount ${i + 1}`] = fmt(p.units);
      });
      details["platform fee"] = fmt(priced.fee);
      details["total you pay"] = fmt(priced.gross);
      return {
        summary: `Split ${fmt(priced.recipientTotal)} between ${pairs.length} recipient${pairs.length === 1 ? "" : "s"} (+ ${fmt(priced.fee)} platform fee)`,
        details,
        quotedAt: Date.now(),
        terms: feeTerms(priced, fee, ctx),
      };
    },
    async build(inputs: ActionInputs, quote: ActionQuoteResult): Promise<UnsignedActionStep[]> {
      // The fee is taken ONLY from the quote's terms (which the build route
      // has already proven equal to the previewed ones) — build never prices
      // the fee itself. Anything inconsistent refuses.
      const fee = termsFromQuote(quote);
      const pairs = collectPairs(inputs, target, fee.treasury);
      const ctx = await resolveTokenCtx(inputString(inputs, "token"));
      const priced = priceSplit(pairs, fee);
      const expected = feeTerms(priced, fee, ctx);
      for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
        if (quote.terms?.[k] !== expected[k]) throw new SplitInputError("This split's fee terms don't match its inputs — request a fresh preview.");
      }

      // Every leg of the one transaction: the user's recipients, exactly as
      // asked, then the platform fee leg (only when the fee is non-zero).
      const legs = pairs.map((p) => ({ recipient: p.recipient, units: p.units }));
      if (priced.fee > 0n) legs.push({ recipient: fee.treasury, units: priced.fee });
      if (legs.length > SPLIT_CONTRACT_MAX_LEGS) throw new SplitInputError("This split has too many legs for the settlement contract.");
      const recipients = legs.map((l) => l.recipient);
      const amounts = legs.map((l) => l.units);
      const gross = amounts.reduce((a, b) => a + b, 0n);
      if (gross !== priced.gross) throw new Error("split_payment: legs must sum to recipients + fee.");
      const tokenArg = ctx.isNative ? NATIVE : ctx.address;
      // Random per-build correlation ref. It never gates execution on-chain
      // (the contract doesn't check it; replay protection is the tx nonce),
      // but because it is inside the calldata, /api/ask/action/confirm's
      // exact calldata match ties a confirmed transaction to THIS build.
      const ref = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      const fmt = (u: bigint) => formatUnits(u, ctx.decimals);

      const steps: UnsignedActionStep[] = [];

      if (!ctx.isNative) {
        // MANDATORY (Phase 5B §8): the allowance is EXACTLY what the
        // settlement will pull — every recipient leg plus the fee leg — never
        // more, never unlimited. Layer B independently re-checks the decoded
        // calldata against this same value.
        const approveAmount = gross;
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
        label: `Split ${fmt(priced.recipientTotal)} ${ctx.symbol} to ${pairs.length} recipient${pairs.length === 1 ? "" : "s"}${priced.fee > 0n ? ` + ${fmt(priced.fee)} ${ctx.symbol} platform fee` : ""}`,
        tx: {
          to: target,
          data: encodeFunctionData({ abi: SPLIT_ABI, functionName: "splitPayment", args: [tokenArg, recipients, amounts, ref] }),
          value: ctx.isNative ? gross.toString() : "0",
        },
      });
      return steps;
    },
    async outflows(inputs: ActionInputs): Promise<readonly ActionOutflow[]> {
      // The user's recipients only. The fee leg goes to PayAI's own
      // Safe-controlled treasury; it isn't a payment to screen.
      const fee = await readSplitFeeTerms();
      const pairs = collectPairs(inputs, target, fee.treasury);
      const ctx = await resolveTokenCtx(inputString(inputs, "token"));
      return pairs.map((p) => ({ recipient: p.recipient, amountUnits: p.units, token: ctx.address, symbol: ctx.symbol, decimals: ctx.decimals }));
    },
    parseResult: (receipt, rctx) => parseSplitReceipt(receipt, target, rctx),
    async settledOutflows(receipt: ActionReceipt, rctx?: ActionResultContext): Promise<SettledOutflows> {
      const settled = decodeSettlement(receipt, target);
      if (!settled) return { recipients: [], fee: null };
      const ctx = await tokenCtxOrNull(settled.token);
      const legs = separateFeeLeg(settled, rctx);
      const token = getAddress(settled.token);
      const symbol = ctx?.symbol ?? "tokens";
      const decimals = ctx?.decimals ?? 0;
      return {
        recipients: legs.recipients.map((l) => ({ recipient: getAddress(l.recipient), amountUnits: l.units, token, symbol, decimals })),
        fee: legs.fee ? { amountUnits: legs.fee.units, token, treasury: getAddress(legs.fee.recipient), symbol, decimals } : null,
      };
    },
  };
}

interface PricedSplit { recipientTotal: bigint; fee: bigint; gross: bigint }

function priceSplit(pairs: Pair[], fee: SplitFeeTerms): PricedSplit {
  const recipientTotal = pairs.reduce((a, p) => a + p.units, 0n);
  const platformFee = splitPlatformFee(recipientTotal, fee.feeBps);
  const gross = recipientTotal + platformFee;
  if (gross > UINT256_MAX) throw new SplitInputError("The split total is too large.");
  return { recipientTotal, fee: platformFee, gross };
}

/** The terms bound into the quote token. Strings only; addresses lowercased
 *  so the canonical form is stable. */
function feeTerms(priced: PricedSplit, fee: SplitFeeTerms, ctx: TokenCtx) {
  return {
    feeBps: String(fee.feeBps),
    treasury: fee.treasury.toLowerCase(),
    feeSource: fee.source.toLowerCase(),
    token: (ctx.isNative ? NATIVE : ctx.address).toLowerCase(),
    recipientTotal: priced.recipientTotal.toString(),
    fee: priced.fee.toString(),
    gross: priced.gross.toString(),
  };
}

/** Read the fee rate/treasury out of a quote's terms, refusing anything
 *  missing or malformed — build must never run without priced terms. */
function termsFromQuote(quote: ActionQuoteResult): SplitFeeTerms {
  const t = quote.terms;
  const feeBps = Number(t?.feeBps);
  const missing = () => new SplitInputError("This split has no valid fee terms — request a fresh preview.");
  if (!t || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100) throw missing();
  if (!t.treasury || !isAddress(t.treasury) || !t.feeSource || !isAddress(t.feeSource)) throw missing();
  return { feeBps, treasury: getAddress(t.treasury), source: getAddress(t.feeSource) };
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
 * Split the confirmed legs into the user's recipients and the platform fee
 * leg. The fee leg is identified ONLY by the build's own terms (the treasury
 * it was built to pay, and the exact fee) — and since the treasury can never
 * be a user recipient, a leg to it with exactly that amount is unambiguously
 * the fee. Without terms (a split built before fees existed), every leg is a
 * recipient.
 */
function separateFeeLeg(settled: SettledSplit, rctx?: ActionResultContext): {
  recipients: { recipient: string; units: bigint }[];
  fee: { recipient: string; units: bigint } | null;
} {
  const legs = settled.recipients.map((r, i) => ({ recipient: r, units: settled.amounts[i] ?? 0n }));
  const treasury = rctx?.terms?.treasury?.toLowerCase();
  const feeUnits = rctx?.terms?.fee;
  if (!treasury || !feeUnits || feeUnits === "0") return { recipients: legs, fee: null };
  const idx = legs.findIndex((l) => l.recipient.toLowerCase() === treasury && l.units.toString() === feeUnits);
  if (idx < 0) return { recipients: legs, fee: null };
  return { recipients: legs.filter((_, i) => i !== idx), fee: legs[idx] };
}

/**
 * Display fields for the confirmed split. Amounts are formatted with the
 * token's real decimals when they can be read; otherwise shown in base units,
 * labelled as such — never guessed. A receipt with no canonical event reports
 * only its status, never a fabricated result. The platform fee is reported
 * separately from the recipients, never as one of them.
 */
async function parseSplitReceipt(receipt: ActionReceipt, canonical: Address, rctx?: ActionResultContext): Promise<Readonly<Record<string, string>>> {
  const settled = decodeSettlement(receipt, canonical);
  if (!settled) return { status: receipt.status };
  const ctx = await tokenCtxOrNull(settled.token);
  const fmt = (u: bigint | undefined) =>
    u == null ? "" : ctx ? `${formatUnits(u, ctx.decimals)} ${ctx.symbol}` : `${u.toString()} base units`;
  const { recipients, fee } = separateFeeLeg(settled, rctx);
  const recipientTotal = recipients.reduce((s, l) => s + l.units, 0n);
  const out: Record<string, string> = {
    status: receipt.status,
    settlementId: settled.settlementId.toString(),
    payer: settled.payer,
    token: ctx ? (ctx.isNative ? "MON (native)" : `${ctx.symbol} (${settled.token})`) : settled.token,
    recipientCount: String(recipients.length),
    "recipients total": fmt(recipientTotal),
    "platform fee": fmt(fee?.units ?? 0n),
    "total paid": fmt(settled.totalAmount),
    transaction: receipt.txHash,
  };
  if (fee) out.treasury = fee.recipient;
  recipients.forEach((l, i) => {
    out[`recipient ${i + 1}`] = l.recipient;
    out[`amount ${i + 1}`] = fmt(l.units);
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
