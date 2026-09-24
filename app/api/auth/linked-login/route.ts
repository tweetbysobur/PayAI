/**
 * Which Google account, if any, opens this passkey wallet.
 * The email is private, so a stranger with only the address gets nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { decodeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { denyPrivateRead } from "@/lib/auth/walletGrant";
import { getLinkedLogin } from "@/lib/platform/linkedLogin";
import { rateLimited } from "@/lib/platform/ratelimit";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: NextRequest) {
  const limited = await rateLimited(req, "linked-login", { max: 30, windowSec: 60 });
  if (limited) return limited;
  const address = req.nextUrl.searchParams.get("address")?.trim() ?? "";
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ linked: null });
  }
  const row = await getLinkedLogin(address);
  if (!row) return NextResponse.json({ linked: null });

  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  const ownsSession = session?.userId === row.userId;
  if (!ownsSession) {
    const denied = await denyPrivateRead(req, address);
    if (denied) return NextResponse.json({ linked: null, locked: true }, { status: 401 });
  }
  return NextResponse.json({
    linked: { method: row.method, label: row.label },
  });
}
