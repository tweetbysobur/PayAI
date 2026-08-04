/**
 * Sign a message with the caller's embedded wallet. The session cookie (not
 * a client-supplied userId) is the source of truth for who's signing — a
 * client can never ask Mera to sign on behalf of an address it doesn't own.
 */
import { NextRequest, NextResponse } from "next/server";
import { decodeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getEmbeddedProvider } from "@/lib/wallet-service/registry";

export async function POST(req: NextRequest) {
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message : "";
  if (!message) return NextResponse.json({ error: "message is required." }, { status: 400 });

  try {
    const embedded = getEmbeddedProvider();
    const signature = await embedded.signMessage({ userId: session.userId, address: session.address, message });
    return NextResponse.json({ signature });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Signing failed." }, { status: 502 });
  }
}
