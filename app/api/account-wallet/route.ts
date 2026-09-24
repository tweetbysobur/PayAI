/**
 * Links the signed-in account to the wallet the browser just unlocked.
 *
 * The session cookie is the only identity. The body cannot name a user.
 * The address and credential id are public; they cannot spend. The link
 * exists so a later sign-in on a device with no passkey is refused a second
 * wallet instead of silently getting an empty one.
 */
import { NextRequest, NextResponse } from "next/server";
import { decodeSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getAccountWallet, putAccountWallet } from "@/lib/platform/accountWallet";
import { rateLimited } from "@/lib/platform/ratelimit";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

export async function PUT(req: NextRequest) {
  const limited = await rateLimited(req, "account-wallet", { max: 20, windowSec: 300 });
  if (limited) return limited;

  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "Sign in before linking a wallet." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const credentialId = typeof body?.credentialId === "string" ? body.credentialId.trim() : "";
  if (!ADDR_RE.test(address) || !ID_RE.test(credentialId)) {
    return NextResponse.json({ error: "A wallet address and passkey id are required." }, { status: 400 });
  }

  const existing = await getAccountWallet(session.userId);
  if (existing && existing.address !== address.toLowerCase()) {
    return NextResponse.json(
      {
        error: "This sign-in already opens a different wallet. Linking Google did not move it.",
        code: "account-has-wallet",
        wallet: existing,
      },
      { status: 409 },
    );
  }

  const wallet = await putAccountWallet(session.userId, { address, credentialId });
  if (!wallet) {
    return NextResponse.json({ error: "Could not link that wallet." }, { status: 400 });
  }
  return NextResponse.json({ wallet });
}
