/**
 * Starts or removes a Google link for the passkey wallet that just signed.
 *
 * POST does not talk to Google itself. It checks the passkey signature and
 * leaves a short httpOnly cookie. The browser then goes to the normal
 * Google sign-in, and the callback attaches that Google account to this
 * wallet only because the cookie is present.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  encodeLinkProof,
  linkProofCookieOpts,
  removeGoogleLink,
  verifyLinkSignature,
  verifyUnlinkSignature,
  GOOGLE_LINK_COOKIE,
} from "@/lib/auth/linkGoogle";
import { decodeSession, SESSION_COOKIE, sessionCookieOpts } from "@/lib/auth/session";
import { rateLimited } from "@/lib/platform/ratelimit";

export async function POST(req: NextRequest) {
  const limited = await rateLimited(req, "link-google", { max: 8, windowSec: 300 });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const credentialId = typeof body?.credentialId === "string" ? body.credentialId.trim() : "";
  const expiresAt = Number(body?.expiresAt);
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  if (!(await verifyLinkSignature(address, credentialId, expiresAt, signature))) {
    return NextResponse.json({ error: "Confirm this with your passkey before linking Google." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    GOOGLE_LINK_COOKIE,
    encodeLinkProof({ address, credentialId, expiresAt }),
    linkProofCookieOpts(req.headers.get("host")),
  );
  return res;
}

export async function DELETE(req: NextRequest) {
  const limited = await rateLimited(req, "unlink-google", { max: 8, windowSec: 300 });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const address = typeof body?.address === "string" ? body.address.trim() : "";
  const expiresAt = Number(body?.expiresAt);
  const signature = typeof body?.signature === "string" ? body.signature.trim() : "";
  if (!(await verifyUnlinkSignature(address, expiresAt, signature))) {
    return NextResponse.json({ error: "Confirm this with your passkey before unlinking Google." }, { status: 401 });
  }

  const removed = await removeGoogleLink(address);
  const res = NextResponse.json({ ok: true, removed: !!removed });
  const session = decodeSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (removed && session?.userId === removed.userId) {
    res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOpts(req.headers.get("host")), maxAge: 0 });
  }
  return res;
}
