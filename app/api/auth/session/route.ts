/** Read or end the current embedded-wallet session. */
import { NextRequest, NextResponse } from "next/server";
import { decodeSession, SESSION_COOKIE, sessionCookieOpts } from "@/lib/auth/session";
import { WALLET_GRANT_COOKIE, walletGrantCookieOpts } from "@/lib/auth/walletGrant";

export async function GET(req: NextRequest) {
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ session });
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  const host = req.headers.get("host");
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOpts(host), maxAge: 0 });
  res.cookies.set(WALLET_GRANT_COOKIE, "", { ...walletGrantCookieOpts(host), maxAge: 0 });
  return res;
}
