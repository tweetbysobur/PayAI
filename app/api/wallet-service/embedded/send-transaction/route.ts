/** Broadcasts a transaction from the caller's embedded wallet — same
 *  session-cookie-is-truth rule as sign-message/route.ts. */
import { NextRequest, NextResponse } from "next/server";
import { decodeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getEmbeddedProvider } from "@/lib/wallet-service/registry";
import { MONAD_CHAIN_ID } from "@/lib/monad/public";

export async function POST(req: NextRequest) {
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const to = typeof body?.to === "string" ? body.to : "";
  if (!to) return NextResponse.json({ error: "to is required." }, { status: 400 });
  const data = typeof body?.data === "string" ? body.data : undefined;
  const value = typeof body?.value === "string" ? body.value : undefined;

  try {
    const embedded = getEmbeddedProvider();
    const txHash = await embedded.sendTransaction({
      userId: session.userId,
      address: session.address,
      tx: { to, data, value },
      chainId: MONAD_CHAIN_ID,
    });
    return NextResponse.json({ txHash });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Transaction failed." }, { status: 502 });
  }
}
