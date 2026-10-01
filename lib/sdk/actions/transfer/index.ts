/**
 * payai/transfer@1.0.0 — PayAI's existing single-recipient send, as an SDK
 * action the Intent Engine can plan and execute.
 *
 * It settles EXACTLY like today's production send (app/api/agent with
 * forwarder payments enabled): through the PayAI forwarder (PayAIForwarderV2),
 * reusing the same calldata encoders (lib/monad/forwarder.ts), the same
 * exact-amount approval, the same fee contract and the same on-chain events.
 *
 *   native MON:  forwarder.forwardPaymentNative(recipient, gross, ref){value: gross}
 *   ERC-20:      token.approve(forwarder, gross)   — exact, skipped if the
 *                existing allowance already covers it (as today's send does)
 *                forwarder.forwardPayment(token, recipient, gross, ref)
 *
 * Fee: the forwarder's own mechanism — fee = floor(gross * feeBps / 10000)
 * taken OUT of the amount sent; the recipient receives gross − fee. Same rate
 * (live feeBps), same treasury, same contract as every send; no second fee
 * path. The terms are read live (lib/sdk/fees.ts), shown in the quote, bound
 * into the quote token, and reproduced exactly at build — or the build is
 * refused. (Split differs on purpose: its fee is added on top.)
 *
 * Security:
 *   - the ONLY transaction target is the configured forwarder (allowlisted);
 *     the approval's only spender is that forwarder. There is no direct
 *     transfer path here — a direct send's target would be the recipient or
 *     the token, which can't be allowlisted — so the action is simply not
 *     registered when forwarder payments are off.
 *   - inputs are recipient (a resolved 0x address — names/.nad are resolved
 *     upstream by lib/payees/resolve.ts under Phase 0 provenance), token
 *     (native MON or PayAI's configured stablecoin only) and amount (exact
 *     base units). Nothing else is accepted.
 *   - the zero address, the forwarder itself and the token contract are
 *     refused as recipients before any step exists.
 *   - confirmed results come only from the forwarder's own PaymentForwarded
 *     (+ FeeCollected) events, checked against the build's terms.
 *
 * Server-only.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { encodeFunctionData, formatUnits, getAddress, isAddress, type Address } from "viem";
import { getChain, getPayAIForwarder, getStablecoin, forwarderPaymentsEnabled } from "@/lib/monad/config";
import {
  ERC20_ALLOWANCE_APPROVE_ABI, decodeFeeCollected, decodePaymentForwarded, encodeForwardPayment, encodeForwardPaymentNative,
} from "@/lib/monad/forwarder";
import { platformFee, readPlatformFeeTerms, PlatformFeeUnavailableError, type PlatformFeeTerms } from "@/lib/sdk/fees";
import { ActionInputError, inputString } from "@/lib/sdk/types";
import type {
  Action, ActionBuildContext, ActionInputs, ActionOutflow, ActionQuoteResult, ActionReceipt, ActionResultContext, ProtocolAdapter,
  SettledOutflows, UnsignedActionStep,
} from "@/lib/sdk/types";

const PROTOCOL_ID = "payai";
const ACTION_ID = "transfer";
const VERSION = "1.0.0";
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const UNITS_RE = /^[1-9][0-9]{0,77}$/;

export class TransferInputError extends ActionInputError {}

interface TokenCtx { isNative: boolean; address: Address; decimals: number; symbol: string }

/** Native MON, or PayAI's ONE configured stablecoin — the same two assets the
 *  existing send supports. Anything else is refused, never guessed. */
function resolveTransferToken(raw: string): TokenCtx {
  const t = raw.trim();
  if (!t || t.toLowerCase() === NATIVE) return { isNative: true, address: NATIVE, decimals: 18, symbol: "MON" };
  let usdc;
  try {
    usdc = getStablecoin();
  } catch {
    throw new TransferInputError("Only MON can be sent right now — no stablecoin is configured.");
  }
  if (!isAddress(t, { strict: false }) || t.toLowerCase() !== usdc.address.toLowerCase()) {
    throw new TransferInputError(`That token can't be sent here — only MON or ${usdc.symbol}.`);
  }
  return { isNative: false, address: getAddress(usdc.address), decimals: usdc.decimals, symbol: usdc.symbol };
}

interface Parsed { recipient: Address; gross: bigint; token: TokenCtx }

function parse(inputs: ActionInputs, forwarder: Address): Parsed {
  const r = inputString(inputs, "recipient").trim();
  const a = inputString(inputs, "amount").trim();
  if (!isAddress(r, { strict: false })) throw new TransferInputError("The recipient is not a valid address.");
  if (!UNITS_RE.test(a)) throw new TransferInputError("The amount must be a positive whole number of base units.");
  const token = resolveTransferToken(inputString(inputs, "token"));
  const recipient = getAddress(r);
  const key = recipient.toLowerCase();
  if (key === NATIVE) throw new TransferInputError("The recipient can't be the zero address.");
  if (key === forwarder.toLowerCase()) throw new TransferInputError("The recipient can't be the PayAI forwarder contract itself.");
  if (!token.isNative && key === token.address.toLowerCase()) throw new TransferInputError("The recipient can't be the token contract.");
  return { recipient, gross: BigInt(a), token };
}

interface Priced { gross: bigint; fee: bigint; net: bigint }

function price(p: Parsed, fee: PlatformFeeTerms): Priced {
  const f = platformFee(p.gross, fee.feeBps);
  return { gross: p.gross, fee: f, net: p.gross - f };
}

function termsOf(p: Parsed, priced: Priced, fee: PlatformFeeTerms) {
  return {
    feeBps: String(fee.feeBps),
    treasury: fee.treasury.toLowerCase(),
    feeSource: fee.source.toLowerCase(),
    token: p.token.address.toLowerCase(),
    recipient: p.recipient.toLowerCase(),
    gross: priced.gross.toString(),
    fee: priced.fee.toString(),
    net: priced.net.toString(),
  };
}

/** The fee terms out of a quote, refusing anything missing — build never
 *  prices the fee itself. */
function termsFromQuote(quote: ActionQuoteResult): PlatformFeeTerms {
  const t = quote.terms;
  const feeBps = Number(t?.feeBps);
  const missing = () => new TransferInputError("This transfer has no valid fee terms — request a fresh preview.");
  if (!t || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 100) throw missing();
  if (!t.treasury || !isAddress(t.treasury) || !t.feeSource || !isAddress(t.feeSource)) throw missing();
  return { feeBps, treasury: getAddress(t.treasury), source: getAddress(t.feeSource) };
}

/** The forwarder's confirmed payment, checked against the build's terms. */
function decodeSettled(receipt: ActionReceipt, forwarder: Address, rctx?: ActionResultContext) {
  if (receipt.status !== "success") return null;
  const ev = decodePaymentForwarded(receipt.logs, forwarder);
  if (!ev) return null;
  const t = rctx?.terms;
  if (t) {
    if (ev.recipient.toLowerCase() !== t.recipient || ev.token.toLowerCase() !== t.token || ev.amount.toString() !== t.gross) return null;
  }
  const fc = decodeFeeCollected(receipt.logs, forwarder, ev.id);
  const fee = fc?.feeAmount ?? 0n;
  if (fee > ev.amount) return null;
  return { ev, fee, treasury: fc?.treasury ?? null, net: ev.amount - fee };
}

function tokenDisplay(token: Address): { symbol: string; decimals: number } | null {
  if (token.toLowerCase() === NATIVE) return { symbol: "MON", decimals: 18 };
  try {
    const usdc = getStablecoin();
    if (usdc.address.toLowerCase() === token.toLowerCase()) return { symbol: usdc.symbol, decimals: usdc.decimals };
  } catch { /* unconfigured */ }
  return null;
}

function transferAction(forwarder: Address, chainId: number): Action {
  return {
    protocolId: PROTOCOL_ID, actionId: ACTION_ID, version: VERSION,
    name: "Send payment", description: "Send MON or USDC to one recipient through PayAI.",
    chainId, allowedTargets: [forwarder],
    historyAction: "send_payment",
    inputSchema: {
      recipient: { type: "address", required: true, description: "Recipient address (resolved by PayAI)" },
      // Optional: absent/zero sentinel = native MON; otherwise PayAI's stablecoin.
      token: { type: "token", required: false, description: "Token to send (leave empty for native MON)" },
      amount: { type: "units", required: true, description: "Amount to send, in the token's base units" },
    },
    // Confirmed outputs (from PaymentForwarded/FeeCollected), bindable by a
    // later node. No recipient output: an address only enters a node through
    // recipient provenance, never from another action.
    outputs: {
      amount: { type: "units", description: "What the recipient received (sent minus the platform fee)", denominatedIn: { input: "token" } },
      gross: { type: "units", description: "What the sender paid", denominatedIn: { input: "token" } },
      fee: { type: "units", description: "The PayAI platform fee", denominatedIn: { input: "token" } },
      token: { type: "token", description: "The token sent" },
    },

    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const p = parse(inputs, forwarder);
      const fee = await readPlatformFeeTerms();
      if (fee.source.toLowerCase() !== forwarder.toLowerCase()) {
        throw new PlatformFeeUnavailableError("This payment is unavailable right now: PayAI's fee configuration doesn't match its forwarder.");
      }
      const priced = price(p, fee);
      const fmt = (u: bigint) => `${formatUnits(u, p.token.decimals)} ${p.token.symbol}`;
      return {
        summary: `Send ${fmt(priced.gross)} to ${p.recipient} (they receive ${fmt(priced.net)} after the ${fee.feeBps / 100}% platform fee)`,
        details: {
          recipient: p.recipient,
          token: p.token.isNative ? "MON (native)" : `${p.token.symbol} (${p.token.address})`,
          "you send": fmt(priced.gross),
          "platform fee": fmt(priced.fee),
          "recipient receives": fmt(priced.net),
        },
        quotedAt: Date.now(),
        terms: termsOf(p, priced, fee),
      };
    },

    async build(inputs: ActionInputs, quote: ActionQuoteResult, ctx?: ActionBuildContext): Promise<UnsignedActionStep[]> {
      const fee = termsFromQuote(quote);
      if (fee.source.toLowerCase() !== forwarder.toLowerCase()) throw new TransferInputError("This transfer's fee terms don't match its forwarder — request a fresh preview.");
      const p = parse(inputs, forwarder);
      const priced = price(p, fee);
      const expected = termsOf(p, priced, fee);
      for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
        if (quote.terms?.[k] !== expected[k]) throw new TransferInputError("This transfer's fee terms don't match its inputs — request a fresh preview.");
      }
      // Random per-build correlation ref (never gates execution on-chain); it
      // is inside the calldata, so confirm's exact match ties the mined tx to
      // THIS build.
      const ref = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
      const fmt = (u: bigint) => `${formatUnits(u, p.token.decimals)} ${p.token.symbol}`;

      if (p.token.isNative) {
        return [{
          kind: "action",
          label: `Send ${fmt(p.gross)} to ${p.recipient}`,
          tx: { to: forwarder, data: encodeForwardPaymentNative(p.recipient, p.gross, ref), value: p.gross.toString() },
        }];
      }

      const steps: UnsignedActionStep[] = [];
      if (!(await allowanceCovers(p.token.address, ctx?.wallet, forwarder, p.gross))) {
        // EXACT approval to the forwarder for the gross amount the forward
        // pulls (fee included — the forwarder takes it from this amount).
        steps.push({
          kind: "approve",
          label: `Approve ${fmt(p.gross)} for PayAI`,
          tx: {
            to: p.token.address,
            data: encodeFunctionData({ abi: ERC20_ALLOWANCE_APPROVE_ABI, functionName: "approve", args: [forwarder, p.gross] }),
            value: "0",
          },
          approval: { token: p.token.address, spender: forwarder, amount: p.gross.toString() },
        });
      }
      steps.push({
        kind: "action",
        label: `Send ${fmt(p.gross)} to ${p.recipient}`,
        tx: { to: forwarder, data: encodeForwardPayment(p.token.address, p.recipient, p.gross, ref), value: "0" },
      });
      return steps;
    },

    async outflows(inputs: ActionInputs): Promise<readonly ActionOutflow[]> {
      // Screened on the gross amount — the same figure the existing send's
      // compliance/risk checks run against.
      const p = parse(inputs, forwarder);
      return [{ recipient: p.recipient, amountUnits: p.gross, token: p.token.address, symbol: p.token.symbol, decimals: p.token.decimals }];
    },

    async parseResult(receipt: ActionReceipt, rctx?: ActionResultContext): Promise<Readonly<Record<string, string>>> {
      const s = decodeSettled(receipt, forwarder, rctx);
      if (!s) return { status: receipt.status };
      const tok = tokenDisplay(s.ev.token);
      const fmt = (u: bigint) => (tok ? `${formatUnits(u, tok.decimals)} ${tok.symbol}` : `${u.toString()} base units`);
      return {
        status: receipt.status,
        paymentId: s.ev.id.toString(),
        recipient: s.ev.recipient,
        token: tok ? tok.symbol : s.ev.token,
        "you sent": fmt(s.ev.amount),
        "platform fee": fmt(s.fee),
        "recipient received": fmt(s.net),
        ...(s.treasury ? { treasury: s.treasury } : {}),
        transaction: receipt.txHash,
      };
    },

    async settledOutflows(receipt: ActionReceipt, rctx?: ActionResultContext): Promise<SettledOutflows> {
      const s = decodeSettled(receipt, forwarder, rctx);
      if (!s) return { recipients: [], fee: null };
      const tok = tokenDisplay(s.ev.token);
      const token = getAddress(s.ev.token);
      const symbol = tok?.symbol ?? "tokens";
      const decimals = tok?.decimals ?? 0;
      return {
        // History records the gross amount sent — exactly what the existing
        // send's rows record — while amountUnits is what was delivered.
        recipients: [{ recipient: getAddress(s.ev.recipient), amountUnits: s.net, recordedAmountUnits: s.ev.amount, token, symbol, decimals }],
        fee: s.fee > 0n && s.treasury ? { amountUnits: s.fee, token, treasury: getAddress(s.treasury), symbol, decimals } : null,
        grossUnits: s.ev.amount,
      };
    },
  };
}

/** Whether `owner` has already approved at least `amount` to the forwarder —
 *  the same check the existing send does. Unknown (no wallet, read failed)
 *  means "not covered": approve exactly, never skip on a guess. */
async function allowanceCovers(token: Address, owner: Address | undefined, forwarder: Address, amount: bigint): Promise<boolean> {
  if (!owner) return false;
  try {
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const current = (await getPublicClient().readContract({
      address: token, abi: ERC20_ALLOWANCE_APPROVE_ABI, functionName: "allowance", args: [owner, forwarder],
    })) as bigint;
    return current >= amount;
  } catch {
    return false;
  }
}

/**
 * The transfer protocol on the active chain, or null when forwarder payments
 * aren't enabled (address configured AND PAYAI_FORWARDER_ENABLED=true — the
 * same two gates the existing send uses). No forwarder, no transfer action.
 */
export function createTransferProtocol(): ProtocolAdapter | null {
  if (!forwarderPaymentsEnabled()) return null;
  const forwarder = getPayAIForwarder();
  if (!forwarder) return null;
  const chainId = getChain().id;
  const target = getAddress(forwarder);
  return {
    protocolId: PROTOCOL_ID,
    name: "PayAI",
    chainId,
    docsUrl: "https://usepayai.xyz",
    allowedTargets: [target],
    actions: [transferAction(target, chainId)],
  };
}
