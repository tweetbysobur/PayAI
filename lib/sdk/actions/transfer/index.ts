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
 * Fee: charged ON TOP (lib/payment/feeOnTop.ts). `amount` is what the
 * recipient receives, in full; the forwarder is handed the smallest gross
 * whose net — its own fee = floor(gross * feeBps / 10000) taken out — is
 * exactly that amount, so the fee comes from the sender's balance on top.
 * Same rate (live feeBps), same treasury, same contract as every send; no
 * second fee path. The terms are read live (lib/sdk/fees.ts), shown in the
 * quote, bound into the quote token, and reproduced exactly at build — or the
 * build is refused. Build also refuses, before any signature, when the
 * wallet can't cover amount + fee.
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
import { feeOnTop } from "@/lib/payment/feeOnTop";
import { ActionInputError, inputString } from "@/lib/sdk/types";
import type {
  Action, ActionBuildContext, ActionInputs, ActionOutflow, ActionQuoteResult, ActionReceipt, ActionResultContext, ProtocolAdapter,
  SettledOutflows, UnsignedActionStep, VerifiedOutputs,
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

/** `amount`: what the recipient receives (the fee is on top). */
interface Parsed { recipient: Address; amount: bigint; token: TokenCtx }

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
  return { recipient, amount: BigInt(a), token };
}

interface Priced { gross: bigint; fee: bigint; net: bigint }

function price(p: Parsed, fee: PlatformFeeTerms): Priced {
  const priced = feeOnTop(p.amount, fee.feeBps);
  // The forwarder's own math on that gross must give back exactly the amount.
  if (priced.gross - platformFee(priced.gross, fee.feeBps) !== p.amount) throw new PlatformFeeUnavailableError("PayAI's fee couldn't be applied to this amount.");
  return priced;
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

/**
 * The STRICT confirmed payment, for confirmed outputs only (decodeSettled
 * above stays as-is for parseResult/settledOutflows/history). Every fact must
 * be established, or null:
 *   - the build's terms and wallet are present;
 *   - exactly one PaymentForwarded from the forwarder, paid BY the build's
 *     wallet, to the terms' recipient, in the terms' token, for the terms'
 *     gross;
 *   - exactly one FeeCollected for that payment id. PayAIForwarderV2 always
 *     emits it — with feeAmount 0 when the fee is zero — so it is required in
 *     both cases, never inferred from its absence: same token, fee equal to
 *     the terms' fee, treasury equal to the terms' treasury;
 *   - gross − fee equals the terms' net.
 */
function verifiedPayment(receipt: ActionReceipt, forwarder: Address, rctx?: ActionResultContext) {
  if (receipt.status !== "success") return null;
  const t = rctx?.terms;
  const wallet = rctx?.wallet?.toLowerCase();
  if (!t || !wallet) return null;
  for (const k of ["recipient", "token", "treasury"] as const) if (!t[k] || !/^0x[0-9a-f]{40}$/.test(t[k])) return null;
  for (const k of ["gross", "fee", "net"] as const) if (!t[k] || !/^(0|[1-9][0-9]{0,77})$/.test(t[k])) return null;

  // Reuse the existing decoders one log at a time, so a second event can't
  // hide behind the first.
  const payments = receipt.logs.map((l) => decodePaymentForwarded([l], forwarder)).filter((e) => e !== null);
  if (payments.length !== 1) return null;
  const ev = payments[0];
  if (
    ev.payer.toLowerCase() !== wallet || ev.recipient.toLowerCase() !== t.recipient ||
    ev.token.toLowerCase() !== t.token || ev.amount.toString() !== t.gross
  ) return null;

  const fees = receipt.logs.map((l) => decodeFeeCollected([l], forwarder, ev.id)).filter((e) => e !== null);
  if (fees.length !== 1) return null;
  const fc = fees[0];
  if (fc.token.toLowerCase() !== t.token || fc.feeAmount.toString() !== t.fee || fc.treasury.toLowerCase() !== t.treasury) return null;
  if (fc.feeAmount > ev.amount || (ev.amount - fc.feeAmount).toString() !== t.net) return null;
  return { token: t.token, gross: ev.amount, fee: fc.feeAmount, net: ev.amount - fc.feeAmount };
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
      amount: { type: "units", required: true, description: "Amount the recipient receives, in the token's base units (PayAI's fee is added on top)" },
    },
    // Confirmed outputs (from PaymentForwarded/FeeCollected), bindable by a
    // later node. No recipient output: an address only enters a node through
    // recipient provenance, never from another action.
    outputs: {
      amount: { type: "units", description: "What the recipient received", denominatedIn: { input: "token" } },
      gross: { type: "units", description: "What the sender paid (amount plus the fee on top)", denominatedIn: { input: "token" } },
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
        summary: `Send ${fmt(priced.net)} to ${p.recipient} (plus the ${fee.feeBps / 100}% PayAI fee: ${fmt(priced.gross)} in total)`,
        details: {
          recipient: p.recipient,
          token: p.token.isNative ? "MON (native)" : `${p.token.symbol} (${p.token.address})`,
          "recipient receives": fmt(priced.net),
          "PayAI fee": fmt(priced.fee),
          "total from your balance": fmt(priced.gross),
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
      const gross = priced.gross;

      // Before any step exists: can this wallet cover the amount AND the fee
      // on top? Says so plainly when only the fee doesn't fit.
      if (ctx?.wallet) {
        const { insufficientWithFeeReason } = await import("@/lib/monad/balance");
        const reason = await insufficientWithFeeReason(ctx.wallet, p.token, priced, fee.feeBps);
        if (reason) throw new TransferInputError(reason);
      }

      if (p.token.isNative) {
        return [{
          kind: "action",
          label: `Send ${fmt(p.amount)} to ${p.recipient} (${fmt(gross)} with the PayAI fee)`,
          tx: { to: forwarder, data: encodeForwardPaymentNative(p.recipient, gross, ref), value: gross.toString() },
        }];
      }

      const steps: UnsignedActionStep[] = [];
      if (!(await allowanceCovers(p.token.address, ctx?.wallet, forwarder, gross))) {
        // EXACT approval to the forwarder for the gross the forward pulls
        // (the amount plus the fee on top).
        steps.push({
          kind: "approve",
          label: `Approve ${fmt(gross)} for PayAI`,
          tx: {
            to: p.token.address,
            data: encodeFunctionData({ abi: ERC20_ALLOWANCE_APPROVE_ABI, functionName: "approve", args: [forwarder, gross] }),
            value: "0",
          },
          approval: { token: p.token.address, spender: forwarder, amount: gross.toString() },
        });
      }
      steps.push({
        kind: "action",
        label: `Send ${fmt(p.amount)} to ${p.recipient} (${fmt(gross)} with the PayAI fee)`,
        tx: { to: forwarder, data: encodeForwardPayment(p.token.address, p.recipient, gross, ref), value: "0" },
      });
      return steps;
    },

    async outflows(inputs: ActionInputs): Promise<readonly ActionOutflow[]> {
      // Screened on the amount the recipient receives — the same figure the
      // existing send's compliance/risk checks run against (the user's amount).
      const p = parse(inputs, forwarder);
      return [{ recipient: p.recipient, amountUnits: p.amount, token: p.token.address, symbol: p.token.symbol, decimals: p.token.decimals }];
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
        // History records the amount the recipient received — the user's own
        // amount, exactly what the existing send's rows record (the fee is on
        // top, in `fee` and grossUnits).
        recipients: [{ recipient: getAddress(s.ev.recipient), amountUnits: s.net, recordedAmountUnits: s.net, token, symbol, decimals }],
        fee: s.fee > 0n && s.treasury ? { amountUnits: s.fee, token, treasury: getAddress(s.treasury), symbol, decimals } : null,
        grossUnits: s.ev.amount,
      };
    },

    // Machine-readable outputs from the STRICT verification only. Unverifiable
    // → null (history above may still record the lenient settlement).
    async confirmedOutputs(receipt: ActionReceipt, rctx?: ActionResultContext): Promise<VerifiedOutputs | null> {
      const v = verifiedPayment(receipt, forwarder, rctx);
      if (!v) return null;
      return {
        outputs: {
          amount: { verified: true, type: "units", value: v.net.toString(), token: v.token },
          gross: { verified: true, type: "units", value: v.gross.toString(), token: v.token },
          fee: { verified: true, type: "units", value: v.fee.toString(), token: v.token },
          token: { verified: true, type: "token", value: v.token },
        },
        denominations: { token: v.token },
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
