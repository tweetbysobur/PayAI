/**
 * A wallet's PayAI username.
 *
 * GET returns the stored handle, or the address-derived default when the
 * owner has never changed it — so every wallet always has an identity and
 * this endpoint never returns nothing.
 *
 * PUT changes it. Ownership is proved with a wallet signature over a message
 * naming the address and the new handle: without that, anyone could rename
 * anyone else's wallet by POSTing an address, which is exactly the kind of
 * impersonation a payment app must not allow.
 */
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/platform/kv";
import { defaultUsername, normalizeUsername, renameMessage, validateUsername } from "@/lib/platform/username";
import { rateLimited } from "@/lib/platform/ratelimit";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const key = (address: string) => `payai:username:${address.toLowerCase()}`;

const g = globalThis as unknown as { __payaiUsernames?: Map<string, string> };
const mem = (g.__payaiUsernames ??= new Map());

async function readStored(address: string): Promise<string | null> {
  const r = await getRedis();
  const raw = r ? await r.get(key(address)) : mem.get(key(address));
  return typeof raw === "string" && raw ? raw : null;
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "A valid wallet address is required." }, { status: 400 });
  }
  const stored = await readStored(address).catch(() => null);
  return NextResponse.json({
    address: address.toLowerCase(),
    username: stored ?? defaultUsername(address),
    isDefault: !stored,
  });
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

  // Only the wallet's owner may rename it.
  const { verifyMessage } = await import("viem");
  const valid = await verifyMessage({
    address: address as `0x${string}`,
    message: renameMessage(address, username),
    signature: signature as `0x${string}`,
  }).catch(() => false);
  if (!valid) {
    return NextResponse.json({ error: "That signature doesn't match this wallet." }, { status: 401 });
  }

  const r = await getRedis();
  if (r) await r.set(key(address), username);
  else mem.set(key(address), username);

  return NextResponse.json({ address: address.toLowerCase(), username, isDefault: false });
}
