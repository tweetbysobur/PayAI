/**
 * A wallet's PayAI username.
 *
 * GET returns the wallet's handle, or null when it hasn't chosen one — PayAI
 * shows the shortened address in that case rather than inventing a name.
 *
 * PUT claims a handle. Two rules make this safe:
 *
 *   1. **Ownership.** The wallet signs a message naming its own address and
 *      the handle. Without that, anyone could rename anyone else's wallet by
 *      POSTing an address.
 *   2. **Uniqueness, first come first served.** A handle is claimed atomically
 *      (SET NX), so two people submitting the same name at the same instant
 *      cannot both succeed. A taken handle is unavailable to everyone else,
 *      including under a look-alike spelling.
 *
 * GET ?available=<name> answers "can I have this?" for live feedback while
 * typing, without needing a signature.
 */
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/platform/kv";
import {
  confusableSkeleton, normalizeUsername, renameMessage, validateUsername,
} from "@/lib/platform/username";
import { rateLimited } from "@/lib/platform/ratelimit";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** address → handle */
const ownerKey = (address: string) => `payai:username:addr:${address.toLowerCase()}`;
/** handle-skeleton → address. The skeleton (not the raw name) is the claimed
 *  key, so `pay1ai` cannot be registered alongside `payai`. */
const claimKey = (name: string) => `payai:username:claim:${confusableSkeleton(name)}`;

const g = globalThis as unknown as { __payaiUsernames?: Map<string, string> };
const mem = (g.__payaiUsernames ??= new Map());

async function kvGet(k: string): Promise<string | null> {
  const r = await getRedis();
  const v = r ? await r.get(k) : mem.get(k);
  return typeof v === "string" && v ? v : null;
}

/** Atomic claim. Returns true only if this call is the one that took it. */
async function kvClaim(k: string, value: string): Promise<boolean> {
  const r = await getRedis();
  if (r) return (await r.set(k, value, { nx: true })) !== null;
  if (mem.has(k)) return false;
  mem.set(k, value);
  return true;
}

async function kvSet(k: string, value: string): Promise<void> {
  const r = await getRedis();
  if (r) await r.set(k, value);
  else mem.set(k, value);
}

async function kvDel(k: string): Promise<void> {
  const r = await getRedis();
  if (r) await r.del(k);
  else mem.delete(k);
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  // Availability check for the "is this name free?" hint while typing.
  const wanted = params.get("available");
  if (wanted !== null) {
    const name = normalizeUsername(wanted);
    const check = validateUsername(name);
    if (!check.ok) return NextResponse.json({ available: false, reason: check.error });
    const holder = await kvGet(claimKey(name)).catch(() => null);
    const asker = params.get("address");
    // Your own handle is "available" to you — re-saving it shouldn't error.
    const mine = !!holder && !!asker && holder.toLowerCase() === asker.toLowerCase();
    return NextResponse.json({
      available: !holder || mine,
      reason: holder && !mine ? "That username is already taken." : undefined,
    });
  }

  const address = params.get("address") ?? "";
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "A valid wallet address is required." }, { status: 400 });
  }
  const username = await kvGet(ownerKey(address)).catch(() => null);
  return NextResponse.json({ address: address.toLowerCase(), username });
}

export async function PUT(req: NextRequest) {
  const limited = await rateLimited(req, "username-set", { max: 10, windowSec: 300 });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const address = typeof body?.address === "string" ? body.address : "";
  const signature = typeof body?.signature === "string" ? body.signature : "";
  const username = normalizeUsername(typeof body?.username === "string" ? body.username : "");

  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "A valid wallet address is required." }, { status: 400 });
  }
  const check = validateUsername(username);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  if (!signature) {
    return NextResponse.json({ error: "Confirm this change in your wallet." }, { status: 401 });
  }

  // Only the wallet's owner may claim a name for it.
  const { verifyMessage } = await import("viem");
  const valid = await verifyMessage({
    address: address as `0x${string}`,
    message: renameMessage(address, username),
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!valid) {
    return NextResponse.json({ error: "That signature doesn't match this wallet." }, { status: 401 });
  }

  const owner = address.toLowerCase();
  const previous = await kvGet(ownerKey(address)).catch(() => null);
  if (previous === username) {
    return NextResponse.json({ address: owner, username }); // no-op
  }

  // First come, first served — atomic, so a simultaneous claim can't collide.
  const claimed = await kvClaim(claimKey(username), owner);
  if (!claimed) {
    const holder = await kvGet(claimKey(username)).catch(() => null);
    if (!holder || holder.toLowerCase() !== owner) {
      return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
    }
    // Already ours (e.g. a retry) — fall through and record it.
  }

  await kvSet(ownerKey(address), username);
  // Release the old handle only after the new one is secured, so a failure
  // part-way through never leaves a wallet with no name and its old name free.
  if (previous) await kvDel(claimKey(previous)).catch(() => {});

  return NextResponse.json({ address: owner, username });
}
