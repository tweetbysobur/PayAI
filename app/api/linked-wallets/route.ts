/**
 * Wallets linked to a PayAI account.
 *
 * GET  ?account=<0x…>  → the wallets attached to that account.
 * PUT  { account, external, label, accountSignature, externalSignature }
 * DELETE { account, external, accountSignature }
 *
 * Writes need proof from BOTH ends — see lib/platform/linkedWallets.ts for why
 * the external signature alone is not enough. Reads are open, on the same
 * terms as every other address-scoped read in PayAI: the data is a list of
 * public addresses, and requiring a signature to view your own wallets would
 * mean a passkey prompt to open a page.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimited } from "@/lib/platform/ratelimit";
import {
  linkMessage, linkWallet, listLinkedWallets, unlinkMessage, unlinkWallet,
} from "@/lib/platform/linkedWallets";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_LABEL = 32;

/** Verifies a personal_sign signature against an address. Returns false on
 *  anything malformed rather than throwing — a bad signature is a 401, not a
 *  500. */
async function signedBy(address: string, message: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const { verifyMessage } = await import("viem");
  return verifyMessage({
    address: address as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  }).catch(() => false);
}

export async function GET(req: NextRequest) {
  const account = req.nextUrl.searchParams.get("account") ?? "";
  if (!ADDR_RE.test(account)) {
    return NextResponse.json({ error: "A valid account address is required." }, { status: 400 });
  }
  const wallets = await listLinkedWallets(account).catch(() => []);
  return NextResponse.json({ account: account.toLowerCase(), wallets });
}

export async function PUT(req: NextRequest) {
  const limited = await rateLimited(req, "link-wallet", { max: 10, windowSec: 300 });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  const external = typeof body?.external === "string" ? body.external.trim() : "";
  const label = (typeof body?.label === "string" ? body.label : "").trim().slice(0, MAX_LABEL);
  const accountSignature = typeof body?.accountSignature === "string" ? body.accountSignature : "";
  const externalSignature = typeof body?.externalSignature === "string" ? body.externalSignature : "";

  if (!ADDR_RE.test(account) || !ADDR_RE.test(external)) {
    return NextResponse.json({ error: "Two valid wallet addresses are required." }, { status: 400 });
  }

  const message = linkMessage(account, external);

  // The external wallet proves it is held by whoever is asking.
  if (!(await signedBy(external, message, externalSignature))) {
    return NextResponse.json(
      { error: "Approve the link in the wallet you're connecting." },
      { status: 401 },
    );
  }
  // The account proves it meant to attach this wallet. Without this, anyone
  // could staple a wallet they control onto a stranger's account — every
  // address is public, so that would take nothing but the victim's.
  if (!(await signedBy(account, message, accountSignature))) {
    return NextResponse.json(
      { error: "Approve the link with your PayAI Wallet passkey." },
      { status: 401 },
    );
  }

  const result = await linkWallet(account, external, label || "External wallet");
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  return NextResponse.json({
    account: account.toLowerCase(),
    wallets: result.wallets,
    alreadyLinked: result.alreadyLinked,
  });
}

export async function DELETE(req: NextRequest) {
  const limited = await rateLimited(req, "link-wallet", { max: 10, windowSec: 300 });
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  const external = typeof body?.external === "string" ? body.external.trim() : "";
  const accountSignature = typeof body?.accountSignature === "string" ? body.accountSignature : "";

  if (!ADDR_RE.test(account) || !ADDR_RE.test(external)) {
    return NextResponse.json({ error: "Two valid wallet addresses are required." }, { status: 400 });
  }

  // Only the account can detach a wallet from itself. The external wallet is
  // deliberately not consulted: someone who has lost access to it still needs
  // to be able to take it off their account.
  if (!(await signedBy(account, unlinkMessage(account, external), accountSignature))) {
    return NextResponse.json(
      { error: "Approve this with your PayAI Wallet passkey." },
      { status: 401 },
    );
  }

  const wallets = await unlinkWallet(account, external);
  return NextResponse.json({ account: account.toLowerCase(), wallets });
}
