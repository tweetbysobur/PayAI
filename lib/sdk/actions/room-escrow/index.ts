/**
 * PayAI Rooms escrow — SDK protocol "payai-rooms" (v1.0.0): the ONLY way the
 * app touches PayAIRoomEscrow (contracts/contracts/PayAIRoomEscrow.sol).
 *
 * Five actions, each a typed call to the one configured escrow — no generic
 * call surface, no caller-supplied target or spender:
 *   create_room — the creator opens a room with immutable terms;
 *   contribute  — pay into a room's escrow (ERC-20: an EXACT approve first);
 *   claim       — creator/beneficiary pays out a COMPLETED room;
 *   refund      — a contributor takes back their own contribution from an
 *                 expired or cancelled room;
 *   cancel_room — the creator cancels an open room (makes everything refundable).
 *
 * They run through the existing pipeline unchanged: plan → quote (read-only,
 * checks the contract's live state) → build (re-checks for the signing
 * wallet) → Layer B (allowed target = the escrow; approve only to the escrow,
 * exact amount) → the user's own wallet signs → settlement verifies the
 * receipt → confirmedOutputs proves the outcome from the escrow's own event,
 * matched against the build's terms and wallet.
 *
 * Registered only when lib/monad/config.ts getRoomEscrow() returns an address
 * (mainnet + PAYAI_ROOM_ESCROW_ENABLED=true + MONAD_MAINNET_ROOM_ESCROW). As of
 * 2026-10-09 no escrow is deployed, so in every real environment this
 * protocol is absent and escrow Rooms are unavailable.
 *
 * Fees: contributions, refunds and cancellation carry NO PayAI fee. The
 * escrow takes its room's snapshotted feeBps (≤ 1%) once, out of the payout,
 * on a successful claim. Every quote says so.
 *
 * Server-side.
 */
import "server-only";
import { encodeFunctionData, formatUnits, getAddress, isAddress, type Address } from "viem";
import { getChain, getRoomEscrow } from "@/lib/monad/config";
import { ActionInputError, inputString } from "@/lib/sdk/types";
import type { Action, ActionInputs, ActionOutflow, ActionQuoteResult, ActionReceipt, ActionResultContext, ProtocolAdapter, UnsignedActionStep, VerifiedOutputs } from "@/lib/sdk/types";
import {
  CHAIN_ROOM_ID_RE, ERC20_APPROVE_ABI, ESCROW_KIND, ESCROW_LIMITS, NATIVE, ROOM_ESCROW_ABI, contributionProblem,
  decodeClaimed, decodeContributed, decodeRefunded, decodeRoomCreated, decodeCancelled, deriveEscrowStatus, escrowClaimFee, feePercent, ROOM_FEE_BPS, ROOM_USDC_DECIMALS, roomMinimumProblem, roomMinimumUnits,
  type ChainRoom,
} from "@/lib/rooms/escrowChain";

export const ROOMS_PROTOCOL_ID = "payai-rooms";
export const ROOMS_VERSION = "1.0.0";
/** A room must stay open at least this long past the moment it's quoted, so
 *  the contract's MIN_DURATION still holds when the transaction lands. */
const SIGNING_MARGIN_SEC = 15 * 60;

export class RoomEscrowInputError extends ActionInputError {}

/** What the actions read from the chain — injectable so the unit tests can
 *  exercise every rule without an RPC (they say so; it is not chain proof). */
export interface EscrowReader {
  room(roomId: bigint): Promise<ChainRoom>;
  contributionOf(roomId: bigint, who: Address): Promise<bigint>;
  tokenSupported(token: Address): Promise<boolean>;
  feeTerms(): Promise<{ feeBps: number; treasury: Address }>;
  paused(): Promise<boolean>;
  nowSec(): Promise<bigint>;
  /** The escrow's platform minimum for a token (PA-05); 0 = not set. */
  minContributionFloor(token: Address): Promise<bigint>;
  /** An ERC-20's live decimals(). */
  tokenDecimals(token: Address): Promise<number>;
}

async function liveReader(): Promise<EscrowReader> {
  const r = await import("@/lib/rooms/escrowRead");
  return {
    room: r.readChainRoom, contributionOf: r.readContributionOf, tokenSupported: r.readTokenSupported,
    feeTerms: r.readEscrowFeeTerms, paused: r.readPaused, nowSec: r.chainNowSec,
    minContributionFloor: r.readMinContributionFloor, tokenDecimals: r.readTokenDecimals,
  };
}

interface TokenCtx { native: boolean; address: Address; decimals: number; symbol: string }

/** MON, or the configured (verified) stablecoin — nothing else, whatever the
 *  contract's own allowlist says. */
async function tokenCtx(input: string): Promise<TokenCtx> {
  const t = input.trim();
  if (!t || t.toLowerCase() === NATIVE) return { native: true, address: NATIVE, decimals: 18, symbol: "MON" };
  if (!isAddress(t)) throw new RoomEscrowInputError("That token isn't a valid address.");
  const { getStablecoin } = await import("@/lib/monad/config");
  let usdc: ReturnType<typeof getStablecoin> | null = null;
  try { usdc = getStablecoin(); } catch { usdc = null; }
  if (usdc && t.toLowerCase() === usdc.address.toLowerCase()) return { native: false, address: getAddress(t), decimals: usdc.decimals, symbol: usdc.symbol };
  throw new RoomEscrowInputError("Rooms accept MON or PayAI's configured USDC only.");
}

function roomIdOf(inputs: ActionInputs): bigint {
  const s = inputString(inputs, "roomId");
  if (!CHAIN_ROOM_ID_RE.test(s)) throw new RoomEscrowInputError("That isn't a valid room id.");
  return BigInt(s);
}

function unitsOf(inputs: ActionInputs, key: string, required: boolean): bigint {
  const s = inputString(inputs, key);
  if (!s) {
    if (required) throw new RoomEscrowInputError(`"${key}" is required.`);
    return 0n;
  }
  if (!/^[1-9][0-9]{0,77}$/.test(s)) throw new RoomEscrowInputError(`"${key}" must be a positive whole number of base units.`);
  return BigInt(s);
}

const fmt = (u: bigint, t: TokenCtx) => `${formatUnits(u, t.decimals)} ${t.symbol}`;
const lc = (a: string) => a.toLowerCase();

/** The room, which must exist and be in this token. */
async function roomIn(reader: EscrowReader, roomId: bigint, token: TokenCtx): Promise<ChainRoom> {
  const room = await reader.room(roomId);
  if (lc(room.creator) === NATIVE) throw new RoomEscrowInputError("That room doesn't exist in the escrow.");
  if (lc(room.token) !== lc(token.address)) throw new RoomEscrowInputError("That room is in a different token.");
  return room;
}

/**
 * PA-05: the platform minimum for this token — only after checking that the
 * live token really has the decimals the policy assumes (USDC: 6) and that the
 * escrow enforces exactly PayAI's value. Anything else fails closed.
 */
async function platformMinimum(rd: EscrowReader, token: TokenCtx): Promise<bigint> {
  if (!token.native) {
    const d = await rd.tokenDecimals(token.address);
    if (d !== ROOM_USDC_DECIMALS || token.decimals !== ROOM_USDC_DECIMALS) {
      throw new RoomEscrowInputError(`New ${token.symbol} rooms are unavailable: the token reports ${d} decimals, but PayAI's 0.5 ${token.symbol} minimum assumes ${ROOM_USDC_DECIMALS}.`);
    }
  }
  const policy = roomMinimumUnits(token);
  const onChain = await rd.minContributionFloor(token.address);
  if (onChain !== policy) {
    throw new RoomEscrowInputError(`New ${token.symbol} rooms are unavailable: the escrow's minimum contribution (${onChain === 0n ? "not set" : fmt(onChain, token)}) doesn't match PayAI's ${fmt(policy, token)}.`);
  }
  return policy;
}

/** Every quote's terms must reproduce at build and match the receipt. */
function sameTerms(quote: ActionQuoteResult, expected: Record<string, string>): void {
  for (const [k, v] of Object.entries(expected)) {
    if (quote.terms?.[k] !== v) throw new RoomEscrowInputError("This room changed since the preview — request a fresh one.");
  }
}

const FEE_NOTE = (bps: number) =>
  bps === 0
    ? "No PayAI fee."
    : `You pay exactly this amount. PayAI deducts a ${feePercent(bps)} platform fee from the room's proceeds only if it completes; refunds are 100%.`;

function verifiedTokenOutputs(token: string, amount: bigint, name = "amount"): VerifiedOutputs {
  const t = lc(token);
  return {
    outputs: { [name]: { verified: true, type: "units", value: amount.toString(), token: t }, token: { verified: true, type: "token", value: t } },
    denominations: { token: t },
  };
}

const TOKEN_FIELD = { type: "token", required: false, description: "The room's token (leave empty for native MON)" } as const;
const ROOM_ID_FIELD = { type: "string", required: true, maxLength: 31, description: "The room's id in the escrow contract" } as const;

/* ── Actions ─────────────────────────────────────────────────────────── */

function createRoomAction(escrow: Address, chainId: number, reader: () => Promise<EscrowReader>): Action {
  async function priced(inputs: ActionInputs) {
    const rd = await reader();
    const token = await tokenCtx(inputString(inputs, "token"));
    const kindIn = inputString(inputs, "kind");
    if (kindIn !== "fixed" && kindIn !== "target") throw new RoomEscrowInputError("A room is either fixed-share or target-based.");
    const raw = inputString(inputs, "beneficiary");
    if (!isAddress(raw)) throw new RoomEscrowInputError("The beneficiary must be a valid address.");
    const beneficiary = getAddress(raw);
    if (lc(beneficiary) === NATIVE || lc(beneficiary) === lc(escrow)) throw new RoomEscrowInputError("That beneficiary can't receive a room's funds.");
    const target = unitsOf(inputs, "goal", true);
    let share = 0n, slots = 0, min = 0n;
    if (kindIn === "fixed") {
      share = unitsOf(inputs, "share", true);
      slots = Number(inputString(inputs, "slots"));
      if (!Number.isInteger(slots) || slots < ESCROW_LIMITS.minSlots || slots > ESCROW_LIMITS.maxSlots) throw new RoomEscrowInputError(`A fixed-share room needs ${ESCROW_LIMITS.minSlots} to ${ESCROW_LIMITS.maxSlots} people.`);
      if (share * BigInt(slots) !== target) throw new RoomEscrowInputError("The target must equal the share times the number of people.");
      if (inputString(inputs, "minContribution")) throw new RoomEscrowInputError("A fixed-share room has no minimum — everyone pays the share.");
    } else {
      if (inputString(inputs, "share") || inputString(inputs, "slots")) throw new RoomEscrowInputError("A target room has no fixed share.");
      min = unitsOf(inputs, "minContribution", false);
    }
    const deadlineStr = inputString(inputs, "deadline");
    if (!/^[1-9][0-9]{0,11}$/.test(deadlineStr)) throw new RoomEscrowInputError("The deadline must be a unix time in seconds.");
    const deadline = BigInt(deadlineStr);
    const now = await rd.nowSec();
    if (deadline < now + BigInt(ESCROW_LIMITS.minDurationSec + SIGNING_MARGIN_SEC)) throw new RoomEscrowInputError("The deadline is too soon — give the room at least an hour and a half.");
    if (deadline > now + BigInt(ESCROW_LIMITS.maxDurationSec)) throw new RoomEscrowInputError("A room can stay open for at most 90 days.");
    const termsHash = inputString(inputs, "termsHash");
    if (!/^0x[0-9a-f]{64}$/.test(termsHash)) throw new RoomEscrowInputError("The room's terms hash is malformed.");
    if (await rd.paused()) throw new RoomEscrowInputError("New rooms are paused right now.");
    if (!token.native && !(await rd.tokenSupported(token.address))) throw new RoomEscrowInputError(`The escrow doesn't accept ${token.symbol} yet.`);
    const fee = await rd.feeTerms();
    // The published Rooms fee is 0.5%. An escrow configured for anything else
    // (e.g. a stale 0.25%) can't be used to create rooms — fail closed.
    if (fee.feeBps !== ROOM_FEE_BPS) throw new RoomEscrowInputError(`New rooms are unavailable: the escrow's fee (${feePercent(fee.feeBps)}) doesn't match PayAI's published ${feePercent(ROOM_FEE_BPS)} Rooms fee.`);
    // PA-05 platform minimum: an omitted target-room minimum defaults to it.
    const floor = await platformMinimum(rd, token);
    if (kindIn === "target" && min === 0n) min = floor;
    const minProblem = roomMinimumProblem(kindIn, { share, target, min }, floor, (u) => fmt(u, token));
    if (minProblem) throw new RoomEscrowInputError(minProblem);
    if (min > target) throw new RoomEscrowInputError("The minimum can't be larger than the target.");
    const terms = {
      escrow: lc(escrow), kind: kindIn, token: lc(token.address), beneficiary: lc(beneficiary), share: share.toString(), slots: String(slots),
      target: target.toString(), minContribution: min.toString(), deadline: deadline.toString(), termsHash, feeBps: String(fee.feeBps), treasury: lc(fee.treasury),
    };
    return { token, kind: kindIn as "fixed" | "target", beneficiary, target, share, slots, min, deadline, termsHash, fee, terms };
  }
  return {
    protocolId: ROOMS_PROTOCOL_ID, actionId: "create_room", version: ROOMS_VERSION,
    name: "Create escrow room", description: "Open a PayAI Room whose funds are held by the escrow contract.",
    chainId, allowedTargets: [escrow],
    inputSchema: {
      kind: { type: "string", required: true, maxLength: 6, description: "fixed or target" },
      token: TOKEN_FIELD,
      beneficiary: { type: "address", required: true, description: "Who receives the funds when the room completes" },
      share: { type: "units", required: false, description: "Fixed-share: each person's exact amount" },
      slots: { type: "number", required: false, description: "Fixed-share: number of people" },
      // "goal", not "target": the plan validator reserves "target" (it would
      // read as a transaction target) and rejects it in any intent.
      goal: { type: "units", required: true, description: "Total the room collects" },
      minContribution: { type: "units", required: false, description: "Target: smallest contribution" },
      deadline: { type: "number", required: true, description: "Unix seconds; contributions close then" },
      termsHash: { type: "string", required: true, maxLength: 66, description: "Hash binding the room's title and description" },
    },
    outputs: {
      goal: { type: "units", description: "The room's goal, as created on-chain", denominatedIn: { input: "token" } },
      token: { type: "token", description: "The room's token" },
    },
    async quote(inputs) {
      const p = await priced(inputs);
      return {
        summary: `Create a ${p.kind === "fixed" ? `${p.slots}-person fixed-share` : "target"} room for ${fmt(p.target, p.token)} (no funds move)`,
        details: {
          escrow,
          type: p.kind === "fixed" ? `Fixed share — ${fmt(p.share, p.token)} from each of ${p.slots} people` : `Target — ${fmt(p.target, p.token)}${p.min > 0n ? `, minimum ${fmt(p.min, p.token)} per contribution` : ""}`,
          beneficiary: p.beneficiary,
          deadline: new Date(Number(p.deadline) * 1000).toISOString(),
          "fee": FEE_NOTE(p.fee.feeBps),
          "if fully funded": `PayAI fee ${fmt(escrowClaimFee(p.target, p.fee.feeBps).fee, p.token)} · beneficiary receives ${fmt(escrowClaimFee(p.target, p.fee.feeBps).net, p.token)}`,
          "terms": "Can't be changed after creation.",
        },
        quotedAt: Date.now(),
        terms: p.terms,
      };
    },
    async build(inputs, quote) {
      const p = await priced(inputs);
      sameTerms(quote, p.terms);
      return [{
        kind: "action",
        label: `Create escrow room for ${fmt(p.target, p.token)}`,
        tx: {
          to: escrow, value: "0",
          data: encodeFunctionData({ abi: ROOM_ESCROW_ABI, functionName: "createRoom", args: [ESCROW_KIND[p.kind], p.token.address, p.beneficiary, p.share, p.slots, p.target, p.min, p.deadline, p.termsHash as `0x${string}`] }),
        },
      }];
    },
    async parseResult(receipt): Promise<Record<string, string>> {
      const ev = decodeRoomCreated(receipt, escrow);
      return ev ? { "room id": ev.roomId.toString(), target: ev.target.toString() } : {};
    },
    async confirmedOutputs(receipt, rctx) {
      const t = rctx?.terms; const ev = decodeRoomCreated(receipt, escrow);
      if (!t || !ev || !rctx?.wallet || lc(ev.creator) !== rctx.wallet) return null;
      const same = t.escrow === lc(escrow) && ESCROW_KIND[t.kind as "fixed" | "target"] === ev.kind && t.token === lc(ev.token) &&
        t.beneficiary === lc(ev.beneficiary) && t.share === ev.share.toString() && t.slots === String(ev.slots) && t.target === ev.target.toString() &&
        t.minContribution === ev.minContribution.toString() && t.deadline === ev.deadline.toString() && t.termsHash === ev.termsHash.toLowerCase() &&
        t.feeBps === String(ev.feeBps) && t.treasury === lc(ev.treasury);
      return same ? verifiedTokenOutputs(ev.token, ev.target, "goal") : null;
    },
  };
}

function contributeAction(escrow: Address, chainId: number, reader: () => Promise<EscrowReader>): Action {
  async function priced(inputs: ActionInputs, wallet?: Address) {
    const rd = await reader();
    const token = await tokenCtx(inputString(inputs, "token"));
    const roomId = roomIdOf(inputs);
    const amount = unitsOf(inputs, "amount", true);
    const room = await roomIn(rd, roomId, token);
    const now = await rd.nowSec();
    const status = deriveEscrowStatus(room, now);
    if (status !== "open") throw new RoomEscrowInputError(`This room is ${status} — it isn't taking contributions.`);
    if (await rd.paused()) throw new RoomEscrowInputError("Contributions are paused right now. Nothing already held is affected.");
    const already = wallet ? await rd.contributionOf(roomId, wallet) : 0n;
    const problem = contributionProblem(room, amount, already, (u) => fmt(u, token));
    if (problem) throw new RoomEscrowInputError(problem);
    const terms = { escrow: lc(escrow), roomId: roomId.toString(), token: lc(token.address), amount: amount.toString(), feeBps: String(room.feeBps), beneficiary: lc(room.beneficiary) };
    return { token, roomId, amount, room, terms };
  }
  return {
    protocolId: ROOMS_PROTOCOL_ID, actionId: "contribute", version: ROOMS_VERSION,
    name: "Contribute to a room", description: "Pay into a PayAI Room's escrow.",
    chainId, allowedTargets: [escrow],
    inputSchema: {
      roomId: ROOM_ID_FIELD,
      amount: { type: "units", required: true, description: "Contribution in the token's base units" },
      token: TOKEN_FIELD,
    },
    outputs: {
      amount: { type: "units", description: "What the escrow recorded for you", denominatedIn: { input: "token" } },
      token: { type: "token", description: "The room's token" },
    },
    async quote(inputs) {
      const p = await priced(inputs);
      return {
        summary: `Contribute ${fmt(p.amount, p.token)} to room #${p.roomId} — held in escrow`,
        details: {
          escrow, "you authorise": fmt(p.amount, p.token), "held by": "PayAI Room escrow contract (not PayAI, not the creator)",
          "fee": FEE_NOTE(p.room.feeBps),
          "if it completes": "Anyone can release the funds; they always go to the beneficiary.",
          "if it doesn't": "You can claim a full refund after the deadline.",
        },
        quotedAt: Date.now(),
        terms: p.terms,
      };
    },
    async build(inputs, quote, ctx) {
      const p = await priced(inputs, ctx?.wallet);
      sameTerms(quote, p.terms);
      const steps: UnsignedActionStep[] = [];
      if (!p.token.native) {
        steps.push({
          kind: "approve",
          label: `Approve exactly ${fmt(p.amount, p.token)} for the room escrow`,
          tx: { to: p.token.address, value: "0", data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [escrow, p.amount] }) },
          approval: { token: p.token.address, spender: escrow, amount: p.amount.toString() },
        });
      }
      steps.push({
        kind: "action",
        label: `Contribute ${fmt(p.amount, p.token)} to room #${p.roomId}`,
        tx: { to: escrow, value: p.token.native ? p.amount.toString() : "0", data: encodeFunctionData({ abi: ROOM_ESCROW_ABI, functionName: "contribute", args: [p.roomId, p.amount] }) },
      });
      return steps;
    },
    // The beneficiary is who ultimately receives this money: PayAI's payment
    // policy (sanctions/risk) screens them, as it does any recipient.
    async outflows(inputs): Promise<readonly ActionOutflow[]> {
      const p = await priced(inputs);
      return [{ recipient: p.room.beneficiary, amountUnits: p.amount, token: p.token.address, symbol: p.token.symbol, decimals: p.token.decimals }];
    },
    async parseResult(receipt): Promise<Record<string, string>> {
      const ev = decodeContributed(receipt, escrow);
      return ev ? { "room id": ev.roomId.toString(), amount: ev.amount.toString(), "room raised": ev.raised.toString() } : {};
    },
    async confirmedOutputs(receipt, rctx) {
      return verifyContribution(receipt, escrow, rctx);
    },
  };
}

/** Exported for the unit tests: the strict contribute check. */
export function verifyContribution(receipt: ActionReceipt, escrow: string, rctx?: ActionResultContext): VerifiedOutputs | null {
  const t = rctx?.terms; const ev = decodeContributed(receipt, escrow);
  if (!t || !ev || !rctx?.wallet) return null;
  if (t.escrow !== lc(escrow) || lc(ev.contributor) !== rctx.wallet || t.roomId !== ev.roomId.toString() || t.amount !== ev.amount.toString()) return null;
  return verifiedTokenOutputs(t.token, ev.amount);
}

function claimAction(escrow: Address, chainId: number, reader: () => Promise<EscrowReader>): Action {
  // Anyone may trigger a claim (PA-11): the contract pays only the room's
  // fixed beneficiary and accrues the fee to its snapshotted treasury.
  async function priced(inputs: ActionInputs) {
    const rd = await reader();
    const token = await tokenCtx(inputString(inputs, "token"));
    const roomId = roomIdOf(inputs);
    const room = await roomIn(rd, roomId, token);
    const status = deriveEscrowStatus(room, await rd.nowSec());
    if (status === "claimed") throw new RoomEscrowInputError("This room has already been claimed.");
    if (status !== "completed") throw new RoomEscrowInputError("Funds can be claimed only once the room is complete.");
    const { fee, net } = escrowClaimFee(room.raised, room.feeBps);
    const terms = { escrow: lc(escrow), roomId: roomId.toString(), token: lc(token.address), net: net.toString(), fee: fee.toString(), beneficiary: lc(room.beneficiary), treasury: lc(room.treasury) };
    return { token, roomId, room, fee, net, terms };
  }
  return {
    protocolId: ROOMS_PROTOCOL_ID, actionId: "claim", version: ROOMS_VERSION,
    name: "Release room funds", description: "Pay a completed room's funds to its fixed beneficiary (anyone may trigger it).",
    chainId, allowedTargets: [escrow],
    inputSchema: { roomId: ROOM_ID_FIELD, token: TOKEN_FIELD },
    outputs: {
      amount: { type: "units", description: "What the beneficiary received", denominatedIn: { input: "token" } },
      token: { type: "token", description: "The room's token" },
    },
    async quote(inputs) {
      const p = await priced(inputs);
      return {
        summary: `Release ${fmt(p.net, p.token)} from room #${p.roomId} to its beneficiary ${p.room.beneficiary}`,
        details: { escrow, "who receives it": `${p.room.beneficiary} (fixed when the room was created)`, "you receive": "Nothing — you only pay network gas", raised: fmt(p.room.raised, p.token), [`PayAI fee (${feePercent(p.room.feeBps)})`]: fmt(p.fee, p.token), "beneficiary receives": fmt(p.net, p.token), beneficiary: p.room.beneficiary },
        quotedAt: Date.now(), terms: p.terms,
      };
    },
    async build(inputs, quote) {
      const p = await priced(inputs);
      sameTerms(quote, p.terms);
      return [{ kind: "action", label: `Release ${fmt(p.net, p.token)} from room #${p.roomId} to its beneficiary`, tx: { to: escrow, value: "0", data: encodeFunctionData({ abi: ROOM_ESCROW_ABI, functionName: "claim", args: [p.roomId] }) } }];
    },
    async parseResult(receipt): Promise<Record<string, string>> {
      const ev = decodeClaimed(receipt, escrow);
      return ev ? { "room id": ev.roomId.toString(), net: ev.net.toString(), fee: ev.fee.toString() } : {};
    },
    async confirmedOutputs(receipt, rctx) {
      const t = rctx?.terms; const ev = decodeClaimed(receipt, escrow);
      if (!t || !ev || !rctx?.wallet) return null;
      if (t.escrow !== lc(escrow) || t.roomId !== ev.roomId.toString() || t.net !== ev.net.toString() || t.fee !== ev.fee.toString() || t.beneficiary !== lc(ev.beneficiary) || t.treasury !== lc(ev.treasury)) return null;
      return verifiedTokenOutputs(t.token, ev.net);
    },
  };
}

function refundAction(escrow: Address, chainId: number, reader: () => Promise<EscrowReader>): Action {
  async function priced(inputs: ActionInputs, wallet?: Address) {
    const rd = await reader();
    const token = await tokenCtx(inputString(inputs, "token"));
    const roomId = roomIdOf(inputs);
    const room = await roomIn(rd, roomId, token);
    const status = deriveEscrowStatus(room, await rd.nowSec());
    if (status !== "expired" && status !== "cancelled") {
      throw new RoomEscrowInputError(status === "open" ? "Refunds open only after the deadline passes without the room completing, or if it's cancelled." : `This room is ${status}, so it isn't refundable.`);
    }
    // The amount is the wallet's own on-chain contribution — read at build
    // (the quote has no wallet); 0 means nothing to refund.
    const amount = wallet ? await rd.contributionOf(roomId, wallet) : null;
    if (amount === 0n) throw new RoomEscrowInputError("You have nothing to refund in this room.");
    return { token, roomId, room, amount, status };
  }
  return {
    protocolId: ROOMS_PROTOCOL_ID, actionId: "refund", version: ROOMS_VERSION,
    name: "Refund from a room", description: "Take back your own contribution from an expired or cancelled room.",
    chainId, allowedTargets: [escrow],
    inputSchema: { roomId: ROOM_ID_FIELD, token: TOKEN_FIELD },
    outputs: {
      amount: { type: "units", description: "What was refunded to you", denominatedIn: { input: "token" } },
      token: { type: "token", description: "The room's token" },
    },
    async quote(inputs) {
      const p = await priced(inputs);
      return {
        summary: `Refund your contribution from room #${p.roomId} (${p.status})`,
        details: { escrow, "you receive": "Your full contribution, as recorded by the escrow", fee: "No PayAI fee on refunds." },
        quotedAt: Date.now(), terms: { escrow: lc(escrow), roomId: p.roomId.toString(), token: lc(p.token.address) },
      };
    },
    async build(inputs, quote, ctx) {
      const p = await priced(inputs, ctx?.wallet);
      sameTerms(quote, { escrow: lc(escrow), roomId: p.roomId.toString(), token: lc(p.token.address) });
      return [{ kind: "action", label: `Refund ${fmt(p.amount!, p.token)} from room #${p.roomId}`, tx: { to: escrow, value: "0", data: encodeFunctionData({ abi: ROOM_ESCROW_ABI, functionName: "refund", args: [p.roomId] }) } }];
    },
    async parseResult(receipt): Promise<Record<string, string>> {
      const ev = decodeRefunded(receipt, escrow);
      return ev ? { "room id": ev.roomId.toString(), amount: ev.amount.toString() } : {};
    },
    async confirmedOutputs(receipt, rctx) {
      const t = rctx?.terms; const ev = decodeRefunded(receipt, escrow);
      if (!t || !ev || !rctx?.wallet) return null;
      if (t.escrow !== lc(escrow) || t.roomId !== ev.roomId.toString() || lc(ev.contributor) !== rctx.wallet || ev.amount <= 0n) return null;
      return verifiedTokenOutputs(t.token, ev.amount);
    },
  };
}

function cancelAction(escrow: Address, chainId: number, reader: () => Promise<EscrowReader>): Action {
  async function priced(inputs: ActionInputs, wallet?: Address) {
    const rd = await reader();
    const token = await tokenCtx(inputString(inputs, "token"));
    const roomId = roomIdOf(inputs);
    const room = await roomIn(rd, roomId, token);
    const status = deriveEscrowStatus(room, await rd.nowSec());
    if (status !== "open") throw new RoomEscrowInputError(`This room is ${status} — only an open room can be cancelled.`);
    if (wallet && lc(wallet) !== lc(room.creator)) throw new RoomEscrowInputError("Only the room's creator can cancel it.");
    return { token, roomId, room };
  }
  return {
    protocolId: ROOMS_PROTOCOL_ID, actionId: "cancel_room", version: ROOMS_VERSION,
    name: "Cancel a room", description: "Cancel an open room; every contribution becomes refundable.",
    chainId, allowedTargets: [escrow],
    inputSchema: { roomId: ROOM_ID_FIELD, token: TOKEN_FIELD },
    // A cancellation moves no funds; what it proves is WHICH room (checked
    // against the terms) in WHICH token. The amount held is read back from
    // the contract by the Rooms service, never inferred.
    outputs: { token: { type: "token", description: "The room's token" } },
    async quote(inputs) {
      const p = await priced(inputs);
      return {
        summary: `Cancel room #${p.roomId} — ${fmt(p.room.raised, p.token)} held becomes refundable`,
        details: { escrow, effect: "No more contributions. Each contributor can claim a full refund.", "can be undone": "No." },
        quotedAt: Date.now(), terms: { escrow: lc(escrow), roomId: p.roomId.toString(), token: lc(p.token.address) },
      };
    },
    async build(inputs, quote, ctx) {
      const p = await priced(inputs, ctx?.wallet);
      sameTerms(quote, { escrow: lc(escrow), roomId: p.roomId.toString(), token: lc(p.token.address) });
      return [{ kind: "action", label: `Cancel room #${p.roomId}`, tx: { to: escrow, value: "0", data: encodeFunctionData({ abi: ROOM_ESCROW_ABI, functionName: "cancel", args: [p.roomId] }) } }];
    },
    async parseResult(receipt): Promise<Record<string, string>> {
      const ev = decodeCancelled(receipt, escrow);
      return ev ? { "room id": ev.roomId.toString() } : {};
    },
    async confirmedOutputs(receipt, rctx) {
      const t = rctx?.terms; const ev = decodeCancelled(receipt, escrow);
      if (!t || !ev || t.escrow !== lc(escrow) || t.roomId !== ev.roomId.toString()) return null;
      return { outputs: { token: { verified: true, type: "token", value: t.token } }, denominations: { token: t.token } };
    },
  };
}

/** The "payai-rooms" protocol on the configured escrow, or null without one. */
export function createRoomEscrowProtocol(escrowOverride?: Address, reader: () => Promise<EscrowReader> = liveReader, chainIdOverride?: number): ProtocolAdapter | null {
  const configured = escrowOverride ?? getRoomEscrow();
  if (!configured) return null;
  const escrow = getAddress(configured);
  const chainId = chainIdOverride ?? getChain().id;
  const actions = [createRoomAction, contributeAction, claimAction, refundAction, cancelAction].map((f) => f(escrow, chainId, reader));
  return { protocolId: ROOMS_PROTOCOL_ID, name: "PayAI Rooms", chainId, docsUrl: "https://usepayai.xyz", allowedTargets: [escrow], actions };
}
