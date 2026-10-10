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
  grantExpiryInWindow,
  verifyWalletGrantSignature,
  WALLET_GRANT_COOKIE,
  walletGrantCookieOpts,
} from "@/lib/auth/walletGrant";
import { rateLimited } from "@/lib/platform/ratelimit";

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

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
  // Same refusal and same bounds as before; the code only lets the browser say
  // "your clock is off" instead of "your signature is wrong".
  if (ADDRESS_SHAPE.test(address) && !grantExpiryInWindow(expiresAt)) {
    return NextResponse.json(
      { error: "Wallet confirmation could not be verified.", code: "grant_expiry_invalid" },
      { status: 401 },
    );
  }
  if (!(await verifyWalletGrantSignature(address, expiresAt, signature))) {
    return NextResponse.json(
      { error: "Wallet confirmation could not be verified.", code: "grant_signature_invalid" },
      { status: 401 },
    );
  }

  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  // Issuing needs AUTH_SESSION_SECRET. Without it no grant is issued; the
  // refusal is a controlled 503, not an unhandled 500.
  let value: string;
  try {
    value = encodeWalletGrant(address, expiresAt);
  } catch {
    return NextResponse.json(
      { error: "Wallet access is unavailable right now.", code: "grant_unavailable" },
      { status: 503 },
    );
  }
  const res = NextResponse.json({ address: address.toLowerCase() });
  res.cookies.set(WALLET_GRANT_COOKIE, value, walletGrantCookieOpts(req.headers.get("host"), maxAge));
  return res;
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(WALLET_GRANT_COOKIE, "", { ...walletGrantCookieOpts(req.headers.get("host")), maxAge: 0 });
  return res;
}
