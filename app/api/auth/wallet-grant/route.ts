/**
 * Issues or clears the cookie that lets this browser read one wallet's
 * PayAI data. The body is a signature, checked against the address. The
 * cookie that comes back is httpOnly, so page script cannot read it out
 * and replay it from another machine.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  decodeWalletGrant,
  encodeWalletGrant,
  verifyWalletGrantSignature,
  WALLET_GRANT_COOKIE,
  walletGrantCookieOpts,
} from "@/lib/auth/walletGrant";
import { rateLimited } from "@/lib/platform/ratelimit";

export async function GET(req: NextRequest) {
  const grant = decodeWalletGrant(req.cookies.get(WALLET_GRANT_COOKIE)?.value);
  return NextResponse.json({ address: grant?.address ?? null });
}

export async function POST(req: NextRequest) {
  const limited = await rateLimited(req, "wallet-grant", { max: 10, windowSec: 300 });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const expiresAt = Number(body?.expiresAt);
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  if (!(await verifyWalletGrantSignature(address, expiresAt, signature))) {
    return NextResponse.json({ error: "Wallet confirmation could not be verified." }, { status: 401 });
  }

  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  const res = NextResponse.json({ address: address.toLowerCase() });
  res.cookies.set(
    WALLET_GRANT_COOKIE,
    encodeWalletGrant(address, expiresAt),
    walletGrantCookieOpts(req.headers.get("host"), maxAge),
  );
  return res;
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(WALLET_GRANT_COOKIE, "", { ...walletGrantCookieOpts(req.headers.get("host")), maxAge: 0 });
  return res;
}
