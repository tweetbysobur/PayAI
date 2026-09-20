/** Read or end the current embedded-wallet session. */
import { NextRequest, NextResponse } from "next/server";
import { decodeSession, SESSION_COOKIE, sessionCookieOpts } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ session });
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOpts(req.headers.get("host")), maxAge: 0 });
  return res;
}
