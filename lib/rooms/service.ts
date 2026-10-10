/**
 * PayAI Rooms — operations. Spec: docs/hackathon/payai-rooms-cleanverse.md §16.
 *
 * Identity is always the caller's wallet grant (passed in as `wallet`), never
 * a field of the request. Every rule lives here; routes stay thin.
 *
 * Money never moves through this module. Paying a share is an ordinary PayAI
 * plan: startContribution writes the transfer request FROM THE ROOM'S OWN
 * TERMS and creates the plan through the existing intake; the participant
 * reviews, approves and signs it with the existing plan card, runner, journal
 * and lock. confirmContribution then reads that plan back through the Plan
 * Service — as the participant — and counts the share only from its verified
 * on-chain outputs, re-checking the receipt independently in Monad mode.
 *
 * Server-only.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { formatUnits, getAddress, type Address } from "viem";
import {
  cleanMemo, deriveStatus, expiryFrom, fixedSplit, NATIVE_ADDRESS, parseRoomRequest, trim,
  type RoomAsset, type RoomRequest, type RoomStatus,
} from "./terms";
import {
  addParticipant, claimTx, createRoomRecord, getCancellation, getParticipant, getRoomRecord, listParticipants,
  putParticipant, roomIdsFor, setCancellation, withParticipantLock, RoomError,
  type ParticipantRecord, type RoomRecord,
} from "./store";

export { RoomError } from "./store";

const ZERO = NATIVE_ADDRESS;

/* ── Assets ────────────────────────────────────────────────────────────── */

/** The assets an OPEN room can use: MON and PayAI's configured stablecoin.
 *  A-USDC (a verified room) is refused until Cleanverse exists (§16.3). */
export async function roomAsset(symbol: string): Promise<RoomAsset> {
  const s = symbol.toUpperCase().replace("-", "");
  if (s === "AUSDC") {
    throw new RoomError("UNSUPPORTED_ASSET", "Verified A-USDC rooms need Cleanverse verification, which isn't connected yet. You can create an open room in USDC or MON.");
  }
  if (s === "MON") return { symbol: "MON", address: ZERO, decimals: 18, native: true };
  const { getStablecoin } = await import("@/lib/monad/config");
  let usdc: { address: string; symbol: string; decimals: number } | null = null;
  try { usdc = getStablecoin(); } catch { usdc = null; }
  if (usdc && s === usdc.symbol.toUpperCase()) return { symbol: usdc.symbol, address: usdc.address.toLowerCase(), decimals: usdc.decimals, native: false };
  throw new RoomError("UNSUPPORTED_ASSET", `Rooms can collect MON${usdc ? ` or ${usdc.symbol}` : ""} — not ${symbol}.`);
}

/* ── Views ─────────────────────────────────────────────────────────────── */

export interface RoomSlotView {
  slot: number;
  /** True only for the viewer's own slot. Nobody sees anyone else's address. */
  you: boolean;
  state: "joined" | "paying" | "paid";
  joinedAt: number;
  paidAt: number | null;
  /** True when the share landed after the room closed (cancelled or expired). */
  afterClose: boolean;
  /** The viewer's own transaction only. */
  txHash: string | null;
}

export interface RoomActivity { at: number; kind: "created" | "joined" | "paid" | "cancelled" | "completed" | "expired"; slot: number | null; you: boolean }

export interface RoomView {
  id: string;
  status: RoomStatus;
  memo: string | null;
  asset: { symbol: string; decimals: number; native: boolean };
  total: string;
  share: string;
  target: number;
  joined: number;
  paid: number;
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  /** Shown to everyone: who the money goes to is part of the terms. */
  recipient: { address: string; label: string | null };
  verified: false;
  viewer: {
    signedIn: boolean;
    isCreator: boolean;
    isRecipient: boolean;
    slot: number | null;
    /** The plan paying this viewer's share, when there is one. */
    planId: string | null;
    canJoin: boolean;
    canPay: boolean;
    canCancel: boolean;
  };
  slots: RoomSlotView[];
  activity: RoomActivity[];
}

export interface RoomSummary { id: string; memo: string | null; status: RoomStatus; symbol: string; total: string; share: string; target: number; paid: number; role: "creator" | "participant"; createdAt: number; expiresAt: number }

function viewOf(room: RoomRecord, parts: ParticipantRecord[], cancelledAt: number | null, viewer: string | null, now: number): RoomView {
  const me = viewer?.toLowerCase() ?? null;
  const confirmed = parts.filter((p) => p.payment.confirmedAt != null).map((p) => p.payment.confirmedAt!);
  const { status, completedAt } = deriveStatus({ cancelledAt, expiresAt: room.expiresAt, target: room.target }, confirmed, now);
  const closedAt = cancelledAt ?? (status === "expired" ? room.expiresAt : null);
  const mine = me ? parts.find((p) => p.address === me) ?? null : null;
  const fmt = (u: string) => trim(formatUnits(BigInt(u), room.asset.decimals));

  const slots: RoomSlotView[] = parts.map((p) => ({
    slot: p.slot,
    you: p.address === me,
    // "paying" only while the room can still take the share; once it has
    // closed, an unpaid place is just unpaid (its plan was abandoned or lapsed).
    state: p.payment.confirmedAt != null ? "paid" : p.payment.planId && status === "open" ? "paying" : "joined",
    joinedAt: p.joinedAt,
    paidAt: p.payment.confirmedAt,
    afterClose: p.payment.confirmedAt != null && ((closedAt != null && p.payment.confirmedAt > closedAt) || p.payment.confirmedAt > room.expiresAt),
    txHash: p.address === me ? p.payment.txHash : null,
  }));

  const activity: RoomActivity[] = [{ at: room.createdAt, kind: "created", slot: null, you: room.creator === me }];
  for (const p of parts) {
    activity.push({ at: p.joinedAt, kind: "joined", slot: p.slot, you: p.address === me });
    if (p.payment.confirmedAt != null) activity.push({ at: p.payment.confirmedAt, kind: "paid", slot: p.slot, you: p.address === me });
  }
  if (cancelledAt != null) activity.push({ at: cancelledAt, kind: "cancelled", slot: null, you: room.creator === me });
  if (completedAt != null) activity.push({ at: completedAt, kind: "completed", slot: null, you: false });
  if (status === "expired") activity.push({ at: room.expiresAt, kind: "expired", slot: null, you: false });
  activity.sort((a, b) => a.at - b.at);

  const isRecipient = me != null && room.recipient === me;
  return {
    id: room.id, status, memo: room.memo,
    asset: { symbol: room.asset.symbol, decimals: room.asset.decimals, native: room.asset.native },
    total: fmt(room.totalUnits), share: fmt(room.shareUnits), target: room.target,
    joined: parts.length, paid: confirmed.length,
    createdAt: room.createdAt, expiresAt: room.expiresAt, completedAt, cancelledAt,
    recipient: { address: getAddress(room.recipient), label: room.recipientLabel },
    verified: false,
    viewer: {
      signedIn: me != null,
      isCreator: me != null && room.creator === me,
      isRecipient,
      slot: mine?.slot ?? null,
      planId: mine?.payment.confirmedAt == null ? mine?.payment.planId ?? null : null,
      canJoin: me != null && !mine && !isRecipient && status === "open" && parts.length < room.target,
      canPay: !!mine && mine.payment.confirmedAt == null && status === "open",
      // In-flight shares are checked precisely when cancelling (cancelRoom).
      canCancel: me != null && room.creator === me && status === "open" && confirmed.length === 0,
    },
    slots, activity,
  };
}

async function load(id: string): Promise<{ room: RoomRecord; parts: ParticipantRecord[]; cancelledAt: number | null }> {
  const room = await getRoomRecord(id);
  if (!room) throw new RoomError("NOT_FOUND", "This room doesn't exist.");
  const [parts, cancel] = await Promise.all([listParticipants(id, room.target), getCancellation(id)]);
  return { room, parts, cancelledAt: cancel?.at ?? null };
}

export async function getRoom(id: string, viewer: string | null, now = Date.now()): Promise<RoomView> {
  const { room, parts, cancelledAt } = await load(id);
  return viewOf(room, parts, cancelledAt, viewer, now);
}

export async function listMyRooms(wallet: string, now = Date.now()): Promise<RoomSummary[]> {
  const out: RoomSummary[] = [];
  for (const id of await roomIdsFor(wallet)) {
    const v = await getRoom(id, wallet, now).catch(() => null);
    if (!v) continue;
    out.push({ id: v.id, memo: v.memo, status: v.status, symbol: v.asset.symbol, total: v.total, share: v.share, target: v.target, paid: v.paid, role: v.viewer.isCreator ? "creator" : "participant", createdAt: v.createdAt, expiresAt: v.expiresAt });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/* ── Create ────────────────────────────────────────────────────────────── */

export interface RoomPreview {
  request: RoomRequest;
  asset: RoomAsset;
  total: string;
  share: string;
  participants: number;
  recipient: { address: string; label: string | null; isCreator: boolean };
  expiresInDays: number;
}

/** Everything the creator confirms, computed — nothing stored. */
export async function previewRoom(wallet: string, text: string): Promise<RoomPreview> {
  const parsed = parseRoomRequest(text);
  if (!parsed.ok) throw new RoomError("INVALID_INPUT", parsed.message);
  const r = parsed.request;
  const asset = await roomAsset(r.symbol);
  const split = fixedSplit(r.amount, r.per, r.participants, asset);
  if (!split.ok) throw new RoomError("INVALID_INPUT", split.message);

  let recipient = { address: getAddress(wallet), label: null as string | null, isCreator: true };
  if (r.recipient) {
    const { resolveRecipientInput } = await import("@/lib/payees/resolve");
    const res = await resolveRecipientInput(r.recipient);
    if (!res.ok) throw new RoomError("INVALID_INPUT", res.message);
    const address = getAddress(res.address);
    if (address.toLowerCase() === ZERO) throw new RoomError("INVALID_INPUT", "That recipient has no usable address.");
    recipient = { address, label: res.source === "address" ? null : res.display, isCreator: address.toLowerCase() === wallet.toLowerCase() };
  }
  return { request: r, asset, total: split.total, share: split.share, participants: r.participants, recipient, expiresInDays: r.expiryDays };
}

export async function createRoom(wallet: string, text: string, memo: unknown, now = Date.now()): Promise<RoomView> {
  const p = await previewRoom(wallet, text);
  const split = fixedSplit(p.request.amount, p.request.per, p.participants, p.asset);
  if (!split.ok) throw new RoomError("INVALID_INPUT", split.message);
  const room: RoomRecord = {
    id: `room_${randomBytes(12).toString("hex")}`,
    creator: wallet.toLowerCase(),
    recipient: p.recipient.address.toLowerCase(),
    recipientLabel: p.recipient.label,
    asset: p.asset,
    totalUnits: split.totalUnits.toString(),
    shareUnits: split.shareUnits.toString(),
    target: p.participants,
    memo: cleanMemo(memo),
    createdAt: now,
    expiresAt: expiryFrom(now, p.expiresInDays),
  };
  await createRoomRecord(room);
  return viewOf(room, [], null, wallet, now);
}

/* ── Join ──────────────────────────────────────────────────────────────── */

export async function joinRoom(id: string, wallet: string, now = Date.now()): Promise<RoomView> {
  const { room, parts, cancelledAt } = await load(id);
  const v = viewOf(room, parts, cancelledAt, wallet, now);
  if (v.status !== "open") throw new RoomError("CLOSED", `This room is ${v.status} — it isn't taking new people.`);
  if (room.recipient === wallet.toLowerCase()) throw new RoomError("RECIPIENT_CANNOT_JOIN", "You're this room's recipient, so you don't pay a share.");
  await addParticipant(id, wallet, room.target, now);
  return getRoom(id, wallet, now);
}

/* ── Pay a share ───────────────────────────────────────────────────────── */

type PlanSvc = typeof import("@/lib/plan/service");

/** True when a plan may still move money (approved/running, or a step sent
 *  but not settled). A plan that only exists unapproved can't. */
function planMayStillPay(plan: Awaited<ReturnType<PlanSvc["getPlan"]>>): boolean {
  if (plan.nodes.some((n) => n.txHash && !n.result)) return true; // sent, not settled
  if (plan.nodes.some((n) => n.signing)) return true;              // signature possibly pending
  if (plan.abandoned || plan.expired) return false;
  return plan.state === "planned" || plan.state === "approved" || plan.state === "running";
}

/**
 * The plan that pays the caller's share: the existing one while it can still
 * complete, otherwise a new one written from the room's terms. Creates a plan;
 * never approves, signs or sends anything.
 */
export async function startContribution(id: string, wallet: string, now = Date.now()): Promise<{ planId: string; plan: unknown; review: unknown }> {
  return withParticipantLock(id, wallet, async () => {
    const { room, parts, cancelledAt } = await load(id);
    const v = viewOf(room, parts, cancelledAt, wallet, now);
    const me = parts.find((p) => p.address === wallet.toLowerCase());
    if (!me) throw new RoomError("NOT_JOINED", "Join the room before paying your share.");
    if (me.payment.confirmedAt != null) throw new RoomError("ALREADY_PAID", "Your share is already paid.");
    const service = await import("@/lib/plan/service");
    const auth = { wallet: wallet as Address };

    if (me.payment.planId) {
      const existing = await service.getPlan(auth, me.payment.planId).catch(() => null);
      if (existing?.state === "completed") throw new RoomError("NOT_SETTLED", "Your payment went through — confirm it to update the room.");
      if (existing && planMayStillPay(existing)) {
        return { planId: existing.planId, ...(await service.getPlanWithReview(auth, existing.planId)) };
      }
    }
    if (v.status !== "open") throw new RoomError("CLOSED", `This room is ${v.status} — shares can't be paid any more.`);

    const share = trim(formatUnits(BigInt(room.shareUnits), room.asset.decimals));
    const text = `send ${share} ${room.asset.symbol} to ${getAddress(room.recipient)}`;
    const { createPlanFromText } = await import("@/lib/plan-intake/intake");
    const created = await createPlanFromText(auth, text);
    if (!created.ok) {
      throw new RoomError("PAYMENT_UNAVAILABLE", created.code === "ACTION_UNAVAILABLE"
        ? "Paying a share isn't available in this environment right now."
        : created.message);
    }
    await putParticipant(id, { ...me, payment: { ...me.payment, planId: created.plan.planId, planCreatedAt: now, txHash: null } });
    return { planId: created.plan.planId, plan: created.plan, review: created.review };
  });
}

/**
 * Count the caller's share — only from the plan the room recorded for them,
 * read back as them, completed, with VERIFIED outputs equal to the room's
 * share and token; and (Monad mode) only if the receipt independently shows
 * the payment from them to the room's recipient. Idempotent.
 */
export async function confirmContribution(id: string, wallet: string, now = Date.now()): Promise<RoomView> {
  const { room, parts } = await load(id);
  const me = parts.find((p) => p.address === wallet.toLowerCase());
  if (!me) throw new RoomError("NOT_JOINED", "You haven't joined this room.");
  if (me.payment.confirmedAt != null) return getRoom(id, wallet, now);
  if (!me.payment.planId) throw new RoomError("NOT_SETTLED", "There's no payment to confirm yet.");

  const service = await import("@/lib/plan/service");
  const plan = await service.getPlan({ wallet: wallet as Address }, me.payment.planId);
  if (plan.state !== "completed") throw new RoomError("NOT_SETTLED", "Your payment hasn't been confirmed on Monad yet.");
  const node = plan.nodes.length === 1 ? plan.nodes[0] : null;
  if (!node || node.ref.protocolId !== "payai" || node.ref.actionId !== "transfer" || !node.txHash || node.result?.status !== "confirmed") {
    throw new RoomError("MISMATCH", "That payment doesn't match this room.");
  }
  const out = node.result.outputs;
  const amount = out?.amount, token = out?.token;
  const tokenOk = (t: string | undefined) => (t ?? "").toLowerCase() === room.asset.address || (room.asset.native && (!t || t.toLowerCase() === ZERO));
  if (amount?.type !== "units" || !amount.verified || amount.value !== room.shareUnits || !tokenOk(amount.token) ||
      token?.type !== "token" || !token.verified || !tokenOk(token.value)) {
    throw new RoomError("MISMATCH", "That payment doesn't match this room's share.");
  }
  await verifyReceipt(node.txHash, wallet, room);

  if (!(await claimTx(node.txHash, id, wallet))) throw new RoomError("TX_ALREADY_COUNTED", "That transaction was already counted for another payment.");
  // Re-read: another tab may have confirmed meanwhile — never overwrite a confirmation.
  const latest = await getParticipant(id, wallet);
  if (latest && latest.payment.confirmedAt == null) {
    await putParticipant(id, { ...latest, payment: { ...latest.payment, txHash: node.txHash, confirmedAt: now } });
  }
  return getRoom(id, wallet, now);
}

/** Monad mode: the receipt itself must show one forwarded payment FROM the
 *  participant TO the room's recipient in the room's token, netting exactly
 *  the share. Simulation mode has no chain to read; the plan's own verified
 *  outputs (already required above) are what count there. */
async function verifyReceipt(txHash: string, wallet: string, room: RoomRecord): Promise<void> {
  if ((process.env.PAYAI_MODE ?? "simulation") !== "monad") return;
  const [{ getPublicClient }, { decodePaymentForwarded, decodeFeeCollected }, { getPayAIForwarder }] = await Promise.all([
    import("@/lib/monad/wallet"), import("@/lib/monad/forwarder"), import("@/lib/monad/config"),
  ]);
  const forwarder = getPayAIForwarder();
  if (!forwarder) throw new RoomError("UNAVAILABLE", "PayAI can't check payments right now. Try again in a moment.");
  let receipt: { status: string; logs: readonly { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }[] };
  try {
    receipt = await getPublicClient().getTransactionReceipt({ hash: txHash as `0x${string}` }) as typeof receipt;
  } catch {
    throw new RoomError("UNAVAILABLE", "Couldn't read that transaction from Monad. Try again in a moment.");
  }
  const mismatch = () => new RoomError("MISMATCH", "That transaction doesn't show your share being paid to this room's recipient.");
  if (receipt.status !== "success") throw mismatch();
  const pays = receipt.logs.map((l) => decodePaymentForwarded([l], forwarder)).filter((e) => e !== null);
  if (pays.length !== 1) throw mismatch();
  const ev = pays[0];
  if (ev.payer.toLowerCase() !== wallet.toLowerCase() || ev.recipient.toLowerCase() !== room.recipient || ev.token.toLowerCase() !== room.asset.address) throw mismatch();
  // PayAIForwarderV2 always emits exactly one FeeCollected per payment (with
  // feeAmount 0 when the fee is 0) — required, never inferred from absence.
  const fees = receipt.logs.map((l) => decodeFeeCollected([l], forwarder, ev.id)).filter((e) => e !== null);
  if (fees.length !== 1 || fees[0].token.toLowerCase() !== room.asset.address || fees[0].feeAmount > ev.amount) throw mismatch();
  const net = ev.amount - fees[0].feeAmount;
  if (net.toString() !== room.shareUnits) throw mismatch();
}

/* ── Cancel ────────────────────────────────────────────────────────────── */

export async function cancelRoom(id: string, wallet: string, now = Date.now()): Promise<RoomView> {
  const { room, parts, cancelledAt } = await load(id);
  if (room.creator !== wallet.toLowerCase()) throw new RoomError("NOT_CREATOR", "Only the person who created this room can cancel it.");
  const v = viewOf(room, parts, cancelledAt, wallet, now);
  if (v.status !== "open") throw new RoomError("NOT_CANCELLABLE", `This room is already ${v.status}.`);
  if (v.paid > 0) throw new RoomError("NOT_CANCELLABLE", "Someone has already paid, so the room can't be cancelled — payments go straight to the recipient and can't be undone.");
  // A share's plan blocks cancellation once it could move money: approved,
  // with a transaction or signature under way, or already completed. A plan
  // that was never approved can't — it is abandoned as part of cancelling,
  // which blocks its approval and every quote, so it can never pay into the
  // cancelled room. Read and abandoned as that participant (the server is
  // the trusted party here; abandoning an unapproved plan is always safe).
  const service = await import("@/lib/plan/service");
  const toAbandon: { wallet: Address; planId: string }[] = [];
  for (const p of parts) {
    if (!p.payment.planId || p.payment.confirmedAt != null) continue;
    const auth = { wallet: p.address as Address };
    let plan: Awaited<ReturnType<PlanSvc["getPlan"]>> | null;
    try {
      plan = await service.getPlan(auth, p.payment.planId);
    } catch (e) {
      if ((e as { code?: unknown })?.code === "NOT_FOUND") continue; // gone: can't pay
      throw e; // unknown state: fail closed
    }
    const live = !plan.abandoned && !plan.expired;
    const moving = plan.state === "completed" || plan.nodes.some((n) => n.txHash || n.signing) ||
      (live && plan.approved && (plan.state === "approved" || plan.state === "running"));
    if (moving) throw new RoomError("NOT_CANCELLABLE", "A participant has a payment under way. Wait for it to finish before cancelling.");
    if (live) toAbandon.push({ wallet: auth.wallet, planId: plan.planId });
  }
  for (const a of toAbandon) await service.abandonPlan({ wallet: a.wallet }, a.planId);
  await setCancellation(id, now);
  return getRoom(id, wallet, now);
}

