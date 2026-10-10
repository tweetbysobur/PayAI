import { NextRequest, NextResponse } from "next/server";
import { MAX_INPUT_LENGTH, sanitizeInput } from "@/lib/agent/brain";
import { understand, type ConversationTurn } from "@/lib/ask/intent/classify";
import type { Understanding } from "@/lib/ask/intent/types";

/**
 * POST /api/ask/understand — the ONLY place Ask PayAI's semantic layer runs.
 * Client sends the new message, recent conversation, and any pending
 * (in-flight) intent; this returns a structured Understanding and nothing
 * else — no transaction is built or executed here. That happens later, only
 * after explicit confirmation, through the existing /api/agent and
 * /api/swap/confirm endpoints (see lib/ask/intent/orchestrate.ts).
 *
 * Unauthenticated on purpose, same posture as /api/agent's own intent-parse
 * step: understanding a message moves no funds and needs no signer.
 */
export async function POST(req: NextRequest) {
  const { createTiming } = await import("@/lib/platform/timing");
  const timing = createTiming("ask.understand");
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: { text?: string; history?: ConversationTurn[]; pending?: Understanding | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawText = body.text?.trim();
  if (!rawText) return NextResponse.json({ error: "text is required" }, { status: 400 });
  if (rawText.length > MAX_INPUT_LENGTH) {
    return NextResponse.json({ error: `text must be ${MAX_INPUT_LENGTH} characters or fewer.` }, { status: 400 });
  }
  const text = sanitizeInput(rawText);

  const history = Array.isArray(body.history)
    ? body.history
        .filter((t): t is ConversationTurn => !!t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
        .slice(-8)
        .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_INPUT_LENGTH) }))
    : [];

  const understanding = await understand(text, history, body.pending ?? null);
  timing.mark("understand");
  return timing.finish(NextResponse.json(understanding), { kind: understanding.kind });
}
