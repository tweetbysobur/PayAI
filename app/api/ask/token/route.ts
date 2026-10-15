import { NextRequest, NextResponse } from "next/server";
import { inspectAddress } from "@/lib/monad/tokenIntelligence";

/**
 * POST /api/ask/token — identifies an arbitrary Monad address and returns
 * real, on-chain-verified data about it. Nothing here signs, approves, or
 * moves funds; it only reads. See lib/monad/tokenIntelligence.ts for the
 * actual inspection logic and lib/ask/intent/orchestrate.ts's
 * dispatchTokenLookup for the only caller.
 *
 * Unauthenticated on purpose, same posture as /api/ask/understand: looking
 * up a token needs no signer and moves nothing. `walletAddress` is optional
 * and only used to report the caller's OWN balance of the token, if given.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: { address?: string; walletAddress?: string | null; amount?: string | null; quoteAsset?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ status: "invalid", error: "Invalid JSON" }, { status: 400 });
  }

  const address = body.address?.trim();
  if (!address) return NextResponse.json({ status: "invalid", error: "address is required" }, { status: 400 });

  const quoteRequest = body.amount?.trim() ? { amount: body.amount.trim(), quoteAsset: body.quoteAsset ?? null } : null;

  try {
    const result = await inspectAddress(address, body.walletAddress ?? null, quoteRequest);
    // A token this wallet already holds becomes a portfolio candidate.
    const held = result.kind === "token" ? Number(result.data.userBalance ?? 0) : 0;
    if (body.walletAddress && held > 0) {
      const { addKnownTokens } = await import("@/lib/portfolio/knownTokens");
      await addKnownTokens(body.walletAddress, [address]).catch(() => {});
    }
    if (result.kind === "invalid") {
      return NextResponse.json({ status: "invalid", error: "That doesn't look like a token address PayAI can check right now." });
    }
    if (result.kind === "wallet") return NextResponse.json({ status: "wallet" });
    if (result.kind === "unknown_contract") return NextResponse.json({ status: "unknown_contract" });
    return NextResponse.json({ status: "token", data: result.data });
  } catch {
    return NextResponse.json({ status: "invalid", error: "Couldn't reach Monad to check that address. Try again in a moment." }, { status: 502 });
  }
}
