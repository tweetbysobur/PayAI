/**
 * API authentication for write endpoints.
 *
 * This gates REAL-MONEY EXECUTION only — it is distinct from tenancy (which is
 * resolved separately from `x-merchant-key`). Policy (fail-closed):
 *   - Simulation mode → open. No funds can move; tenancy scopes data.
 *   - Monad execution (PAYAI_MODE=monad with MONAD_AGENT_PRIVATE_KEY):
 *       · VERIPAYAI_API_KEY unset → REFUSE (don't expose an unprotected signer).
 *       · set → require a matching `x-api-key` / `Authorization: Bearer`.
 *
 * Checks env directly (no viem import) so the auth path stays light in simulation mode.
 */
import { NextRequest, NextResponse } from "next/server";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Returns a 401/403 response to short-circuit, or null when the request may proceed. */
export function authError(req: NextRequest): NextResponse | null {
  const mode = process.env.PAYAI_MODE;
  const signerLive = mode === "monad" && !!process.env.MONAD_AGENT_PRIVATE_KEY;

  // No live signer → nothing to protect here (data access is scoped by tenancy).
  if (!signerLive) return null;

  const configured = process.env.VERIPAYAI_API_KEY?.trim();
  if (!configured) {
    return NextResponse.json(
      { error: "API key required: set VERIPAYAI_API_KEY before exposing a live signer." },
      { status: 403 },
    );
  }

  const header = req.headers.get("x-api-key") ?? req.headers.get("authorization") ?? "";
  const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
  if (!provided || !constantTimeEqual(provided, configured)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}
