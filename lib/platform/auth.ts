/**
 * API authentication for write endpoints.
 *
 * This gates REAL-MONEY EXECUTION only — it is distinct from tenancy (which is
 * resolved separately from `x-merchant-key`). Policy (fail-closed):
 *   - No live execution (mock/demo) → open. No funds can move; tenancy scopes data.
 *   - Live execution (VERIGATE_MODE=monad with MONAD_AGENT_PRIVATE_KEY, OR
 *     VERIGATE_MODE=live which forwards real transfers to a VeriGate instance):
 *       · VERIPAYAI_API_KEY unset → REFUSE (don't expose an unprotected signer).
 *       · set → require a matching `x-api-key` / `Authorization: Bearer`.
 *
 * VERIGATE_MODE=live moves real funds via the VeriGate pipeline even without a
 * Monad signer configured, so it must be treated as "live" here too — gating
 * only on mode==="monad" would let anyone reach a configured live VeriGate
 * instance with no API key at all.
 *
 * Checks env directly (no viem import) so the auth path stays light in mock mode.
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
  const mode = process.env.VERIGATE_MODE;
  const signerLive =
    (mode === "monad" && !!process.env.MONAD_AGENT_PRIVATE_KEY) || mode === "live";

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
