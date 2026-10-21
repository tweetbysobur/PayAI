/**
 * Escrow Rooms — operations. The one place every escrow Room rule lives; the
 * Rooms API, the public room page and Ask PayAI all call this.
 *
 * Authority:
 *   - money, status, progress, contributor count, claimable and refundable
 *     amounts → the PayAIRoomEscrow contract, read live (lib/rooms/escrowRead);
 *   - a room's text and link → KV, bound on-chain by termsHash;
 *   - "this transaction did X" → the escrow's own event in the receipt,
 *     decoded strictly (lib/rooms/escrowChain) and matched to the room, the
 *     action and the wallet — never a client claim, never a pending tx.
 *
 * Every state change is an ordinary PayAI plan of one "payai-rooms" action,
 * created here from the room's own terms; the person reviews, approves and
 * signs it with the existing plan card. Nothing here signs or sends.
 *
 * With no reviewed escrow configured (the case everywhere as of 2026-10-09)
 * every operation refuses with ESCROW_UNAVAILABLE. Nothing is simulated.
 *
 * Server-only.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import { RoomError, withParticipantLock } from "./store";
import { roomsAllowed } from "./access";
import { trim, type RoomAsset } from "./terms";
import {
  CHAIN_ROOM_ID_RE, ESCROW_KIND, ESCROW_LIMITS, NATIVE, contributionProblem, decodeCancelled, decodeClaimed, decodeContributed,
  decodeRefunded, decodeRoomCreated, escrowClaimFee, feePercent, roomMinimumProblem, roomMinimumUnits, roomTermsHash, ROOM_FEE_BPS, ROOM_USDC_DECIMALS, type ChainRoom, type EscrowKind, type EscrowStatus, type ReceiptLike,
} from "./escrowChain";
import {
  addPublic, adoptEscrowChain, createEscrowRecord, getEscrowChain, getEscrowPlan, getEscrowRecord, listPublicIds, logEscrowEvent,
  readEscrowLog, setEscrowPlan, ESCROW_ID_RE, type EscrowActionKind, type EscrowLogEntry, type EscrowRoomRecord,
} from "./escrowStore";

export const TITLE_MIN = 3, TITLE_MAX = 80, DESCRIPTION_MAX = 500;
export const MAX_DURATION_DAYS = 90;
const ACTION_ID: Record<EscrowActionKind, string> = { create: "create_room", contribute: "contribute", claim: "claim", refund: "refund", cancel: "cancel_room" };
const ROOMS = { protocolId: "payai-rooms", version: "1.0.0" } as const;

/* ── Availability ───────────────────────────────────────────────────── */

export interface EscrowAvailability { available: boolean; reason: string | null; escrow: string | null }

export async function escrowAvailability(): Promise<EscrowAvailability> {
  const { getRoomEscrow } = await import("@/lib/monad/config");
  const escrow = getRoomEscrow();
  if (!escrow) return { available: false, reason: "Escrow Rooms aren't live yet: the escrow contract hasn't been deployed and reviewed. No funds can be held until it is.", escrow: null };
  const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  const { getAction } = await import("@/lib/sdk/registry");
  ensureBuiltinsRegistered();
  if (!getAction(ROOMS.protocolId, "contribute", ROOMS.version)) return { available: false, reason: "Escrow Rooms are unavailable in this environment.", escrow };
  return { available: true, reason: null, escrow: escrow.toLowerCase() };
}

/**
 * Optional private test: PAYAI_ROOM_ESCROW_CREATORS is a comma list of wallets
 * allowed to CREATE escrow rooms. Unset means everyone. Contributing, claiming
 * and refunding are never restricted, so nobody's money can get stuck.
 */
export function escrowCreatorAllowed(wallet: string): boolean {
  return roomsAllowed(wallet);
}

export const ESCROW_CREATORS_REASON = "Escrow rooms are in a private test. You can still join escrow rooms and start a direct split.";

/** Whether this wallet can start an escrow room right now. */
export async function escrowCreateAvailability(wallet: string): Promise<{ available: boolean; reason: string | null }> {
  const a = await escrowAvailability();
  if (!a.available) return { available: false, reason: a.reason };
  if (!escrowCreatorAllowed(wallet)) return { available: false, reason: ESCROW_CREATORS_REASON };
  return { available: true, reason: null };
}

function requireCreatorAllowed(wallet: string): void {
  if (!escrowCreatorAllowed(wallet)) throw new RoomError("ESCROW_UNAVAILABLE", ESCROW_CREATORS_REASON);
}

async function requireAvailable(): Promise<string> {
  const a = await escrowAvailability();
  if (!a.available || !a.escrow) throw new RoomError("ESCROW_UNAVAILABLE", a.reason ?? "Escrow Rooms are unavailable.");
  return a.escrow;
}

async function chain<T>(fn: (r: typeof import("./escrowRead")) => Promise<T>): Promise<T> {
  const r = await import("./escrowRead");
  try {
    return await fn(r);
  } catch (e) {
    if (e instanceof r.EscrowUnavailableError) throw new RoomError("ESCROW_UNAVAILABLE", e.message);
    throw e;
  }
}

/* ── Preview & create ───────────────────────────────────────────────── */

export interface EscrowRoomForm {
  kind: EscrowKind;
  /** "MON" or the configured stablecoin's symbol. */
  token: string;
  /** Decimal. Fixed: each person's share. Target: the target. */
  amount: string;
  /** Fixed only. */
  participants?: number;
  /** Target only; decimal; optional. */
  minContribution?: string;
  durationDays: number;
  /** 0x or .nad; empty = the creator. */
  beneficiary?: string;
  title: string;
  description: string;
  publicListing: boolean;
}

export interface EscrowRoomPreview {
  kind: EscrowKind;
  asset: { symbol: string; decimals: number; native: boolean; address: string };
  share: string | null;
  participants: number | null;
  target: string;
  minContribution: string | null;
  durationDays: number;
  beneficiary: { address: string; label: string | null; isCreator: boolean };
  title: string;
  description: string;
  publicListing: boolean;
  fee: { bps: number; percent: string; onSuccess: string; beneficiaryReceives: string };
  escrow: string;
  conditions: string[];
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function units(amount: unknown, asset: RoomAsset, what: string): bigint {
  if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,30})(\.[0-9]+)?$/.test(amount.trim())) throw new RoomError("INVALID_INPUT", `Give ${what} as a plain positive number, like 100 or 2.5.`);
  const a = amount.trim();
  if ((a.split(".")[1] ?? "").length > asset.decimals) throw new RoomError("INVALID_INPUT", `${asset.symbol} has ${asset.decimals} decimal places — ${what} has more.`);
  const u = parseUnits(a, asset.decimals);
  if (u <= 0n) throw new RoomError("INVALID_INPUT", `${what[0].toUpperCase()}${what.slice(1)} must be more than zero.`);
  return u;
}

const shortA = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const show = (u: bigint, asset: { decimals: number; symbol: string }) => `${trim(formatUnits(u, asset.decimals))} ${asset.symbol}`;

interface Priced {
  form: EscrowRoomForm; asset: RoomAsset; shareUnits: bigint; slots: number; targetUnits: bigint; minUnits: bigint;
  beneficiary: { address: string; label: string | null; isCreator: boolean }; title: string; description: string; feeBps: number; escrow: string;
}

async function price(wallet: string, raw: unknown): Promise<Priced> {
  const escrow = await requireAvailable();
  const f = (raw ?? {}) as Partial<EscrowRoomForm>;
  if (f.kind !== "fixed" && f.kind !== "target") throw new RoomError("INVALID_INPUT", "Choose fixed shares or a fundraising target.");
  const { roomAsset } = await import("./service");
  const asset = await roomAsset(typeof f.token === "string" ? f.token : "");
  const title = clean(f.title, TITLE_MAX);
  if (title.length < TITLE_MIN) throw new RoomError("INVALID_INPUT", "Give the room a title (at least 3 characters).");
  const description = clean(f.description, DESCRIPTION_MAX);
  const days = Number(f.durationDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DURATION_DAYS) throw new RoomError("INVALID_INPUT", `A room can stay open for 1 to ${MAX_DURATION_DAYS} days.`);

  let shareUnits = 0n, slots = 0, targetUnits: bigint, minUnits = 0n;
  if (f.kind === "fixed") {
    shareUnits = units(f.amount, asset, "each share");
    slots = Number(f.participants);
    if (!Number.isInteger(slots) || slots < ESCROW_LIMITS.minSlots || slots > ESCROW_LIMITS.maxSlots) throw new RoomError("INVALID_INPUT", `A fixed-share room needs ${ESCROW_LIMITS.minSlots} to ${ESCROW_LIMITS.maxSlots} people.`);
    targetUnits = shareUnits * BigInt(slots);
  } else {
    targetUnits = units(f.amount, asset, "the target");
    if (f.minContribution != null && String(f.minContribution).trim() !== "") {
      minUnits = units(String(f.minContribution), asset, "the minimum");
    }
  }
  // PA-05 platform minimum (policy; checked against the live token and escrow below).
  const policyMin = (() => {
    try { return roomMinimumUnits(asset); } catch { throw new RoomError("ESCROW_UNAVAILABLE", `New ${asset.symbol} rooms are unavailable: PayAI's 0.5 ${asset.symbol} minimum assumes ${ROOM_USDC_DECIMALS} decimals.`); }
  })();
  if (f.kind === "target" && minUnits === 0n) minUnits = policyMin; // an omitted minimum is the platform minimum
  const minProblem = roomMinimumProblem(f.kind, { share: shareUnits, target: targetUnits, min: minUnits }, policyMin, (u) => show(u, asset));
  if (minProblem) throw new RoomError("INVALID_INPUT", minProblem);
  if (minUnits > targetUnits) throw new RoomError("INVALID_INPUT", "The minimum can't be larger than the target.");

  let beneficiary = { address: getAddress(wallet), label: null as string | null, isCreator: true };
  const named = typeof f.beneficiary === "string" ? f.beneficiary.trim() : "";
  if (named) {
    const { resolveRecipientInput } = await import("@/lib/payees/resolve");
    const res = await resolveRecipientInput(named);
    if (!res.ok) throw new RoomError("INVALID_INPUT", res.message);
    const address = getAddress(res.address);
    if (address.toLowerCase() === NATIVE || address.toLowerCase() === escrow) throw new RoomError("INVALID_INPUT", "That beneficiary has no usable address.");
    beneficiary = { address, label: res.source === "address" ? null : res.display, isCreator: address.toLowerCase() === wallet.toLowerCase() };
  }

  const fee = await chain((r) => r.readEscrowFeeTerms());
  // Fail closed on any fee other than the published 0.5% (e.g. a stale 0.25%).
  if (fee.feeBps !== ROOM_FEE_BPS) {
    throw new RoomError("ESCROW_UNAVAILABLE", `New rooms are unavailable: the escrow's fee (${feePercent(fee.feeBps)}) doesn't match PayAI's published ${feePercent(ROOM_FEE_BPS)} Rooms fee.`);
  }
  if (!asset.native && !(await chain((r) => r.readTokenSupported(getAddress(asset.address))))) {
    throw new RoomError("UNSUPPORTED_ASSET", `The escrow doesn't accept ${asset.symbol} yet.`);
  }
  // PA-05: verify the live token's decimals before relying on 0.5 USDC = 500,000
  // units, and that the escrow enforces exactly PayAI's minimum — else fail closed.
  if (!asset.native) {
    const d = await chain((r) => r.readTokenDecimals(getAddress(asset.address)));
    if (d !== ROOM_USDC_DECIMALS) throw new RoomError("ESCROW_UNAVAILABLE", `New ${asset.symbol} rooms are unavailable: the token reports ${d} decimals, but PayAI's 0.5 ${asset.symbol} minimum assumes ${ROOM_USDC_DECIMALS}.`);
  }
  const floor = await chain((r) => r.readMinContributionFloor(getAddress(asset.address)));
  if (floor !== policyMin) {
    throw new RoomError("ESCROW_UNAVAILABLE", `New ${asset.symbol} rooms are unavailable: the escrow's minimum contribution (${floor === 0n ? "not set" : show(floor, asset)}) doesn't match PayAI's ${show(policyMin, asset)}.`);
  }
  return { form: { ...f, durationDays: days, publicListing: f.publicListing === true } as EscrowRoomForm, asset, shareUnits, slots, targetUnits, minUnits, beneficiary, title, description, feeBps: fee.feeBps, escrow };
}

/** Every condition, in words — what the creator previews and the page shows. */
export function conditionsText(kind: EscrowKind, a: { target: string; share: string | null; participants: number | null; min: string | null; feePercent: string; net: string; beneficiary: string }): string[] {
  const lines = kind === "fixed"
    ? [`Each of ${a.participants} people pays exactly ${a.share}, once. The room completes when all ${a.participants} shares are in (${a.target}).`]
    : [`Anyone can contribute${a.min ? ` at least ${a.min} (or exactly the final amount still needed, if that's less)` : ""}, up to what's still needed. The room completes when it reaches ${a.target}.`];
  return [
    ...lines,
    "Contributions are held by the PayAI Room escrow contract — not by PayAI and not by the creator.",
    "Contributions close at the deadline. Late contributions are refused by the contract.",
    `If the room completes in time, anyone can release the payout — it always goes to ${a.beneficiary}, who receives ${a.net}. PayAI deducts its ${a.feePercent} platform fee from successful proceeds only — contributions are never charged extra.`,
    "The creator can cancel the room at any time before it completes. Once it has completed, it can't be cancelled.",
    "If the deadline passes without completing, or the creator cancels, every contributor can claim a full refund (no fee) — directly from the contract, even without PayAI.",
    "These terms are fixed when the room is created and can't be changed afterwards.",
  ];
}

export async function previewEscrowRoom(wallet: string, form: unknown): Promise<EscrowRoomPreview> {
  requireCreatorAllowed(wallet);
  const p = await price(wallet, form);
  const { fee, net } = escrowClaimFee(p.targetUnits, p.feeBps);
  const percent = feePercent(p.feeBps);
  const benName = p.beneficiary.isCreator ? "you" : p.beneficiary.label ?? shortA(p.beneficiary.address);
  return {
    kind: p.form.kind,
    asset: { symbol: p.asset.symbol, decimals: p.asset.decimals, native: p.asset.native, address: p.asset.address },
    share: p.form.kind === "fixed" ? trim(formatUnits(p.shareUnits, p.asset.decimals)) : null,
    participants: p.form.kind === "fixed" ? p.slots : null,
    target: trim(formatUnits(p.targetUnits, p.asset.decimals)),
    minContribution: p.minUnits > 0n ? trim(formatUnits(p.minUnits, p.asset.decimals)) : null,
    durationDays: p.form.durationDays,
    beneficiary: p.beneficiary,
    title: p.title, description: p.description, publicListing: p.form.publicListing,
    fee: { bps: p.feeBps, percent, onSuccess: show(fee, p.asset), beneficiaryReceives: show(net, p.asset) },
    escrow: p.escrow,
    conditions: conditionsText(p.form.kind, {
      target: show(p.targetUnits, p.asset), share: p.form.kind === "fixed" ? show(p.shareUnits, p.asset) : null, participants: p.slots || null,
      min: p.minUnits > 0n ? show(p.minUnits, p.asset) : null, feePercent: percent, net: show(net, p.asset), beneficiary: benName,
    }),
  };
}

/** Plan that runs exactly one payai-rooms action, written from the room's terms. */
async function planFor(wallet: string, kind: EscrowActionKind, inputs: Record<string, unknown>, text: string) {
  const service = await import("@/lib/plan/service");
  const { newIntentId } = await import("@/lib/plan-intake/intake");
  const { getChain } = await import("@/lib/monad/config");
  const auth = { wallet: getAddress(wallet) as Address };
  const draft = {
    id: newIntentId(), version: 1, chainId: getChain().id, wallet: auth.wallet,
    nodes: [{
      nodeId: "n1", ref: { protocolId: ROOMS.protocolId, actionId: ACTION_ID[kind], version: ROOMS.version }, inputs, dependsOn: [],
      validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
    }],
    source: { text, adapter: "deterministic", adapterVersion: "rooms-escrow-1" },
    status: "draft",
  };
  const plan = await service.createPlan(auth, draft);
  return { planId: plan.planId, ...(await service.getPlanWithReview(auth, plan.planId)) };
}

const lit = (value: string) => ({ kind: "literal", value });

export async function createEscrowRoom(wallet: string, form: unknown, now = Date.now()): Promise<{ id: string; planId: string; plan: unknown; review: unknown }> {
  requireCreatorAllowed(wallet);
  const p = await price(wallet, form);
  const nowSec = await chain((r) => r.chainNowSec());
  const deadline = Number(nowSec) + p.form.durationDays * 86400;
  const meta = { title: p.title, description: p.description, publicListing: p.form.publicListing };
  const rec: EscrowRoomRecord = {
    id: `er_${randomBytes(12).toString("hex")}`, mode: "escrow", kind: p.form.kind, creator: wallet.toLowerCase(),
    beneficiary: p.beneficiary.address.toLowerCase(), beneficiaryLabel: p.beneficiary.label, asset: p.asset,
    title: p.title, description: p.description, publicListing: p.form.publicListing,
    shareUnits: p.shareUnits.toString(), slots: p.slots, targetUnits: p.targetUnits.toString(), minUnits: p.minUnits.toString(),
    deadline, termsHash: roomTermsHash(meta), escrow: p.escrow, feeBps: p.feeBps, createdAt: now,
  };
  const ben = getAddress(rec.beneficiary);
  const inputs: Record<string, unknown> = {
    kind: lit(rec.kind),
    beneficiary: { kind: "recipient", display: ben, source: "address", address: ben },
    goal: lit(rec.targetUnits),
    deadline: lit(String(deadline)),
    termsHash: lit(rec.termsHash),
  };
  if (!rec.asset.native) inputs.token = lit(rec.asset.address);
  if (rec.kind === "fixed") { inputs.share = lit(rec.shareUnits); inputs.slots = lit(String(rec.slots)); }
  else if (p.minUnits > 0n) inputs.minContribution = lit(rec.minUnits);

  await createEscrowRecord(rec);
  const plan = await planFor(wallet, "create", inputs, `create escrow room ${rec.id} for ${show(p.targetUnits, p.asset)} paid to ${ben}`);
  await setEscrowPlan(rec.id, wallet, "create", plan.planId);
  return { id: rec.id, ...plan };
}

/* ── Views ──────────────────────────────────────────────────────────── */

export interface EscrowActivity { kind: EscrowLogEntry["kind"]; amount: string; at: number; txHash: string; you: boolean; n: number | null }

export interface EscrowRoomView {
  id: string;
  mode: "escrow";
  kind: EscrowKind;
  title: string;
  description: string;
  publicListing: boolean;
  asset: { symbol: string; decimals: number; native: boolean; address: string };
  beneficiary: { address: string; label: string | null };
  target: string;
  share: string | null;
  slots: number | null;
  minContribution: string | null;
  deadline: number;
  createdAt: number;
  feeBps: number;
  escrow: string;
  /** True once the creation receipt verified and the room exists on-chain. */
  live: boolean;
  chainRoomId: string | null;
  createTx: string | null;
  /** Live contract state; null when not live or the chain can't be read. */
  chain: null | {
    status: EscrowStatus;
    raised: string; remaining: string; refunded: string; held: string;
    contributors: number; progressBps: number; completedAt: number | null;
    termsMatch: boolean;
    claimable: { net: string; fee: string } | null;
  };
  chainError: string | null;
  unavailable: string | null;
  conditions: string[];
  activity: EscrowActivity[];
  /** Contributions on-chain that PayAI didn't itself verify (e.g. made
   *  directly with the contract): counted in totals, absent from activity. */
  unlistedRaised: string | null;
  viewer: {
    signedIn: boolean; isCreator: boolean; isBeneficiary: boolean;
    contributed: string | null; refundable: string | null;
    canContribute: boolean; canClaim: boolean; canRefund: boolean; canCancel: boolean; canFinishCreate: boolean;
    pending: Partial<Record<EscrowActionKind, string>>;
  };
}

export interface EscrowSummary {
  id: string; mode: "escrow"; kind: EscrowKind; title: string; symbol: string; target: string; raised: string | null;
  contributors: number | null; status: EscrowStatus | "pending"; deadline: number; role: "creator" | "contributor"; createdAt: number;
}

function chainId(chainRec: { roomId: string } | null): bigint | null {
  return chainRec && CHAIN_ROOM_ID_RE.test(chainRec.roomId) ? BigInt(chainRec.roomId) : null;
}

export async function getEscrowRoom(id: string, viewer: string | null): Promise<EscrowRoomView> {
  const rec = await getEscrowRecord(id);
  if (!rec) throw new RoomError("NOT_FOUND", "This room doesn't exist.");
  const avail = await escrowAvailability();
  const chainRec = await getEscrowChain(id);
  const me = viewer?.toLowerCase() ?? null;
  const fmt = (u: bigint) => trim(formatUnits(u, rec.asset.decimals));
  const log = await readEscrowLog(id);
  const { fee, net } = escrowClaimFee(BigInt(rec.targetUnits), rec.feeBps);
  const percent = feePercent(rec.feeBps);

  let contributorNo = 0;
  const firstSeen = new Map<string, number>();
  const activity: EscrowActivity[] = log.map((e) => {
    let n: number | null = null;
    if (e.kind === "contributed") {
      if (!firstSeen.has(e.actor)) firstSeen.set(e.actor, ++contributorNo);
      n = firstSeen.get(e.actor)!;
    }
    return { kind: e.kind, amount: fmt(BigInt(e.amountUnits)), at: e.at, txHash: e.txHash, you: me != null && e.actor === me, n };
  });

  const view: EscrowRoomView = {
    id, mode: "escrow", kind: rec.kind, title: rec.title, description: rec.description, publicListing: rec.publicListing,
    asset: { symbol: rec.asset.symbol, decimals: rec.asset.decimals, native: rec.asset.native, address: rec.asset.address },
    beneficiary: { address: getAddress(rec.beneficiary), label: rec.beneficiaryLabel },
    target: fmt(BigInt(rec.targetUnits)), share: rec.kind === "fixed" ? fmt(BigInt(rec.shareUnits)) : null,
    slots: rec.kind === "fixed" ? rec.slots : null, minContribution: BigInt(rec.minUnits) > 0n ? fmt(BigInt(rec.minUnits)) : null,
    deadline: rec.deadline * 1000, createdAt: rec.createdAt, feeBps: rec.feeBps, escrow: rec.escrow,
    live: chainRec != null, chainRoomId: chainRec?.roomId ?? null, createTx: chainRec?.txHash ?? null,
    chain: null, chainError: null, unavailable: avail.available ? null : avail.reason,
    conditions: conditionsText(rec.kind, {
      target: show(BigInt(rec.targetUnits), rec.asset), share: rec.kind === "fixed" ? show(BigInt(rec.shareUnits), rec.asset) : null,
      participants: rec.kind === "fixed" ? rec.slots : null, min: BigInt(rec.minUnits) > 0n ? show(BigInt(rec.minUnits), rec.asset) : null,
      feePercent: percent, net: `${show(net, rec.asset)} if fully funded (${show(fee, rec.asset)} fee)`, beneficiary: rec.beneficiaryLabel ?? shortA(getAddress(rec.beneficiary)),
    }),
    activity, unlistedRaised: null,
    viewer: {
      signedIn: me != null, isCreator: me === rec.creator, isBeneficiary: me === rec.beneficiary,
      contributed: null, refundable: null, canContribute: false, canClaim: false, canRefund: false, canCancel: false,
      canFinishCreate: me === rec.creator && chainRec == null && avail.available, pending: {},
    },
  };
  if (me) {
    for (const k of ["create", "contribute", "claim", "refund", "cancel"] as const) {
      const pid = await getEscrowPlan(id, me, k);
      if (pid) view.viewer.pending[k] = pid;
    }
  }

  const rid = chainId(chainRec);
  if (rid == null || !avail.available || avail.escrow !== rec.escrow) {
    if (rid != null && avail.available && avail.escrow !== rec.escrow) view.chainError = "This room lives on a different escrow contract than the one PayAI is configured for.";
    return view;
  }
  try {
    const r = await import("./escrowRead");
    const [room, status] = await Promise.all([r.readChainRoom(rid), r.readStatus(rid)]);
    const held = status === "claimed" ? 0n : room.raised - room.refunded;
    const claimable = status === "completed" ? escrowClaimFee(room.raised, room.feeBps) : null;
    view.chain = {
      status, raised: fmt(room.raised), remaining: fmt(room.target - room.raised), refunded: fmt(room.refunded), held: fmt(held),
      contributors: room.contributors, progressBps: room.target > 0n ? Number((room.raised * 10000n) / room.target) : 0,
      completedAt: room.completedAt > 0n ? Number(room.completedAt) * 1000 : null,
      termsMatch: termsMatch(rec, room),
      claimable: claimable ? { net: fmt(claimable.net), fee: fmt(claimable.fee) } : null,
    };
    const listed = log.filter((e) => e.kind === "contributed").reduce((s, e) => s + BigInt(e.amountUnits), 0n);
    if (room.raised > listed) view.unlistedRaised = fmt(room.raised - listed);
    if (me) {
      const who = getAddress(me);
      const [mine, refundable] = await Promise.all([r.readContributionOf(rid, who), r.readRefundableOf(rid, who)]);
      view.viewer.contributed = fmt(mine);
      view.viewer.refundable = refundable > 0n ? fmt(refundable) : null;
      view.viewer.canContribute = status === "open" && view.chain.termsMatch && (rec.kind === "target" || mine === 0n);
      view.viewer.canClaim = status === "completed"; // anyone signed in may release it to the beneficiary
      view.viewer.canRefund = refundable > 0n;
      view.viewer.canCancel = status === "open" && me === rec.creator;
    }
  } catch (e) {
    view.chainError = e instanceof Error && e.message ? e.message : "Couldn't read the escrow contract.";
  }
  return view;
}

/** The on-chain room must carry exactly the terms PayAI shows. */
export function termsMatch(rec: EscrowRoomRecord, room: ChainRoom): boolean {
  return room.creator.toLowerCase() === rec.creator && room.beneficiary.toLowerCase() === rec.beneficiary &&
    room.token.toLowerCase() === rec.asset.address.toLowerCase() && room.kind === ESCROW_KIND[rec.kind] &&
    room.share.toString() === rec.shareUnits && room.slots === rec.slots && room.target.toString() === rec.targetUnits &&
    room.minContribution.toString() === rec.minUnits && room.deadline === BigInt(rec.deadline) &&
    room.termsHash.toLowerCase() === rec.termsHash.toLowerCase() && room.feeBps === rec.feeBps;
}

export async function escrowSummary(id: string, wallet: string): Promise<EscrowSummary | null> {
  const v = await getEscrowRoom(id, wallet).catch(() => null);
  if (!v) return null;
  return {
    id, mode: "escrow", kind: v.kind, title: v.title, symbol: v.asset.symbol, target: v.target, raised: v.chain?.raised ?? null,
    contributors: v.chain?.contributors ?? null, status: v.chain?.status ?? "pending", deadline: v.deadline,
    role: v.viewer.isCreator ? "creator" : "contributor", createdAt: v.createdAt,
  };
}

/** Escrow rooms this wallet created or contributed to, newest first. */
export async function listMyEscrowRooms(wallet: string): Promise<EscrowSummary[]> {
  const { roomIdsFor } = await import("./store");
  const out: EscrowSummary[] = [];
  for (const id of await roomIdsFor(wallet)) {
    if (!ESCROW_ID_RE.test(id)) continue;
    const s = await escrowSummary(id, wallet);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/* ── Actions ────────────────────────────────────────────────────────── */

type PlanSvc = typeof import("@/lib/plan/service");
type PlanView = Awaited<ReturnType<PlanSvc["getPlan"]>>;

function planMayStillRun(plan: PlanView): boolean {
  if (plan.nodes.some((n) => n.txHash && !n.result)) return true;
  if (plan.nodes.some((n) => n.signing)) return true;
  if (plan.abandoned || plan.expired) return false;
  return plan.state === "planned" || plan.state === "approved" || plan.state === "running";
}

export interface FundsCheck { enough: boolean | null; message: string | null }

/** Can `wallet` cover `amount` (+ gas)? Exact base units. `enough: null`
 *  when balances can't be read — the wallet and contract still refuse a
 *  short payment, so an RPC hiccup doesn't block one. */
export async function checkFunds(wallet: string, asset: RoomAsset, amount: bigint): Promise<FundsCheck> {
  const GAS = 10n ** 16n; // ~0.01 MON — the app's existing gas reserve (lib/monad/balance.ts)
  try {
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const c = getPublicClient();
    const who = getAddress(wallet);
    const mon = await c.getBalance({ address: who });
    if (asset.native) {
      if (mon < amount + GAS) return { enough: false, message: `You have ${show(mon, { decimals: 18, symbol: "MON" })}. This needs ${show(amount, { decimals: 18, symbol: "MON" })} plus about 0.01 MON for network fees. Add MON to this wallet, then try again.` };
      return { enough: true, message: null };
    }
    const bal = await c.readContract({ address: getAddress(asset.address), abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [who] });
    if (bal < amount) return { enough: false, message: `You have ${show(bal, asset)}. This needs ${show(amount, asset)}. Add ${asset.symbol} to this wallet, then try again.` };
    if (mon < GAS) return { enough: false, message: "You need a little MON (about 0.01) to pay network fees. Add some MON to this wallet, then try again." };
    return { enough: true, message: null };
  } catch {
    return { enough: null, message: null };
  }
}

/**
 * The plan for one escrow action by `wallet`: an existing one while it can
 * still run, otherwise a new one — after checking eligibility against the
 * CONTRACT. Creates a plan only; never signs or sends.
 */
export async function startEscrowAction(id: string, wallet: string, kind: Exclude<EscrowActionKind, "create">, amountInput?: unknown): Promise<{ planId: string; plan: unknown; review: unknown; funds: FundsCheck | null }> {
  await requireAvailable();
  return withParticipantLock(id, `${wallet}:${kind}`, async () => {
    const rec = await getEscrowRecord(id);
    if (!rec) throw new RoomError("NOT_FOUND", "This room doesn't exist.");
    const chainRec = await getEscrowChain(id);
    const rid = chainId(chainRec);
    if (rid == null) throw new RoomError("NOT_LIVE", "This room hasn't been created on-chain yet.");
    const service = await import("@/lib/plan/service");
    const auth = { wallet: getAddress(wallet) as Address };

    const existingId = await getEscrowPlan(id, wallet, kind);
    if (existingId) {
      const existing = await service.getPlan(auth, existingId).catch(() => null);
      if (existing?.state === "completed") throw new RoomError("NOT_SETTLED", "That went through — confirm it to update the room.");
      if (existing && planMayStillRun(existing)) return { planId: existing.planId, ...(await service.getPlanWithReview(auth, existing.planId)), funds: null };
    }

    const room = await chain((x) => x.readChainRoom(rid));
    const status = await chain((x) => x.readStatus(rid));
    if (!termsMatch(rec, room)) throw new RoomError("MISMATCH", "This room's on-chain terms don't match what PayAI shows, so PayAI won't act on it.");
    const me = wallet.toLowerCase();
    const inputs: Record<string, unknown> = { roomId: lit(rid.toString()) };
    if (!rec.asset.native) inputs.token = lit(rec.asset.address);
    let text = `${kind} escrow room ${id}`;
    let funds: FundsCheck | null = null;

    if (kind === "contribute") {
      if (status !== "open") throw new RoomError("CLOSED", `This room is ${status} — it isn't taking contributions.`);
      const amount = rec.kind === "fixed" ? BigInt(rec.shareUnits) : units(amountInput, rec.asset, "your contribution");
      const mine = await chain((x) => x.readContributionOf(rid, getAddress(wallet)));
      const problem = contributionProblem(room, amount, mine, (u) => show(u, rec.asset));
      if (problem) throw new RoomError("NOT_ELIGIBLE", problem);
      inputs.amount = lit(amount.toString());
      text = `contribute ${show(amount, rec.asset)} to escrow room ${id}`;
      funds = await checkFunds(wallet, rec.asset, amount);
      if (funds.enough === false) throw new RoomError("NOT_ELIGIBLE", funds.message!);
    } else if (kind === "claim") {
      // Anyone may release a completed room's payout (PA-11); it always goes
      // to the room's fixed beneficiary — the caller receives nothing.
      if (status === "claimed") throw new RoomError("NOT_ELIGIBLE", "This room has already been claimed.");
      if (status !== "completed") throw new RoomError("NOT_ELIGIBLE", "Funds can be claimed only once the room is complete.");
    } else if (kind === "refund") {
      const refundable = await chain((x) => x.readRefundableOf(rid, getAddress(wallet)));
      if (refundable === 0n) {
        throw new RoomError("NOT_ELIGIBLE", status === "open" ? "Refunds open only if the deadline passes without the room completing, or the creator cancels." : status === "completed" || status === "claimed" ? "This room completed, so contributions go to the beneficiary." : "You have nothing to refund in this room.");
      }
    } else {
      if (me !== rec.creator) throw new RoomError("NOT_CREATOR", "Only the person who created this room can cancel it.");
      if (status !== "open") throw new RoomError("NOT_CANCELLABLE", `This room is already ${status}.`);
    }
    const plan = await planFor(wallet, kind, inputs, text);
    await setEscrowPlan(id, wallet, kind, plan.planId);
    return { ...plan, funds };
  });
}

async function receiptOf(txHash: string): Promise<ReceiptLike> {
  try {
    const { getPublicClient } = await import("@/lib/monad/wallet");
    return (await getPublicClient().getTransactionReceipt({ hash: txHash as `0x${string}` })) as unknown as ReceiptLike;
  } catch {
    throw new RoomError("UNAVAILABLE", "Couldn't read that transaction from Monad. Try again in a moment.");
  }
}

/** The completed, confirmed transaction of the wallet's plan for `kind`. */
async function settledTx(id: string, wallet: string, kind: EscrowActionKind): Promise<string> {
  const planId = await getEscrowPlan(id, wallet, kind);
  if (!planId) throw new RoomError("NOT_SETTLED", "There's nothing to confirm yet.");
  const service = await import("@/lib/plan/service");
  const plan = await service.getPlan({ wallet: getAddress(wallet) as Address }, planId);
  if (plan.state !== "completed") throw new RoomError("NOT_SETTLED", "That transaction hasn't been confirmed on Monad yet.");
  const node = plan.nodes.length === 1 ? plan.nodes[0] : null;
  if (!node || node.ref.protocolId !== ROOMS.protocolId || node.ref.actionId !== ACTION_ID[kind] || !node.txHash || node.result?.status !== "confirmed") {
    throw new RoomError("MISMATCH", "That transaction doesn't match this room.");
  }
  return node.txHash;
}

/**
 * Record the outcome of the wallet's confirmed `kind` transaction — only from
 * the escrow's own event in its receipt, matched to this room and wallet.
 * Idempotent. Never counts a pending transaction.
 */
export async function confirmEscrowAction(id: string, wallet: string, kind: EscrowActionKind, now = Date.now()): Promise<EscrowRoomView> {
  const escrow = await requireAvailable();
  const rec = await getEscrowRecord(id);
  if (!rec) throw new RoomError("NOT_FOUND", "This room doesn't exist.");
  if (rec.escrow !== escrow) throw new RoomError("MISMATCH", "This room was set up on a different escrow contract.");
  const me = wallet.toLowerCase();
  const txHash = await settledTx(id, wallet, kind);
  const receipt = await receiptOf(txHash);
  const mismatch = () => new RoomError("MISMATCH", "That transaction doesn't show what this room expects.");

  if (kind === "create") {
    if (me !== rec.creator) throw new RoomError("NOT_CREATOR", "Only the creator can finish creating this room.");
    const ev = decodeRoomCreated(receipt, escrow);
    if (!ev || ev.creator.toLowerCase() !== me) throw mismatch();
    const fake: ChainRoom = { ...ev, raised: 0n, refunded: 0n, contributors: 0, completedAt: 0n, claimed: false, cancelled: false };
    if (!termsMatch(rec, fake)) throw new RoomError("MISMATCH", "The room created on-chain doesn't match the terms you previewed (for example the fee changed). PayAI won't list it; cancel it on-chain if anyone could reach it.");
    if (!(await adoptEscrowChain(id, { roomId: ev.roomId.toString(), txHash: txHash.toLowerCase(), adoptedAt: now }))) throw new RoomError("TX_ALREADY_COUNTED", "That on-chain room already belongs to another PayAI room.");
    if (rec.publicListing) await addPublic(id);
    await setEscrowPlan(id, wallet, "create", null);
    return getEscrowRoom(id, wallet);
  }

  const rid = chainId(await getEscrowChain(id));
  if (rid == null) throw new RoomError("NOT_LIVE", "This room hasn't been created on-chain yet.");
  let entry: EscrowLogEntry;
  if (kind === "contribute") {
    const ev = decodeContributed(receipt, escrow);
    if (!ev || ev.roomId !== rid || ev.contributor.toLowerCase() !== me) throw mismatch();
    entry = { kind: "contributed", txHash, actor: me, amountUnits: ev.amount.toString(), at: now };
  } else if (kind === "claim") {
    const ev = decodeClaimed(receipt, escrow);
    if (!ev || ev.roomId !== rid || ev.beneficiary.toLowerCase() !== rec.beneficiary) throw mismatch();
    entry = { kind: "claimed", txHash, actor: me, amountUnits: ev.net.toString(), at: now };
  } else if (kind === "refund") {
    const ev = decodeRefunded(receipt, escrow);
    if (!ev || ev.roomId !== rid || ev.contributor.toLowerCase() !== me) throw mismatch();
    entry = { kind: "refunded", txHash, actor: me, amountUnits: ev.amount.toString(), at: now };
  } else {
    const ev = decodeCancelled(receipt, escrow);
    if (!ev || ev.roomId !== rid || me !== rec.creator) throw mismatch();
    entry = { kind: "cancelled", txHash, actor: me, amountUnits: "0", at: now };
  }
  if (!(await logEscrowEvent(id, entry))) throw new RoomError("TX_ALREADY_COUNTED", "That transaction was already counted for something else.");
  await setEscrowPlan(id, wallet, kind, null);
  return getEscrowRoom(id, wallet);
}

/* ── Live Rooms ─────────────────────────────────────────────────────── */

export interface PublicRoomCard {
  id: string; kind: EscrowKind; title: string; symbol: string; target: string; raised: string; remaining: string;
  progressBps: number; contributors: number; deadline: number; status: EscrowStatus;
}

let publicCache: { at: number; cards: PublicRoomCard[] } | null = null;
const PUBLIC_TTL_MS = 20_000;

/** Rooms whose creators opted in — live on the escrow, terms matching. All
 *  numbers from the contract. Short cache so the page can't hammer the RPC. */
export async function listPublicRooms(now = Date.now()): Promise<PublicRoomCard[]> {
  await requireAvailable();
  if (publicCache && now - publicCache.at < PUBLIC_TTL_MS) return publicCache.cards;
  const cards: PublicRoomCard[] = [];
  for (const id of await listPublicIds(100)) {
    if (!ESCROW_ID_RE.test(id)) continue;
    const v = await getEscrowRoom(id, null).catch(() => null);
    if (!v || !v.publicListing || !v.live || !v.chain || !v.chain.termsMatch) continue;
    cards.push({
      id, kind: v.kind, title: v.title, symbol: v.asset.symbol, target: v.target, raised: v.chain.raised, remaining: v.chain.remaining,
      progressBps: v.chain.progressBps, contributors: v.chain.contributors, deadline: v.deadline, status: v.chain.status,
    });
  }
  publicCache = { at: now, cards };
  return cards;
}

export function __resetPublicCacheForTests(): void {
  publicCache = null;
}

export const isEscrowRoomId = (id: string) => ESCROW_ID_RE.test(id);
