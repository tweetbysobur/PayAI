import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/assistant — the AI Payment Assistant.
 * Answers natural-language questions over the merchant's own data and performs
 * quick actions (create payment link / invoice). Key-free.
 * Body: { question: string }
 */
export async function POST(req: NextRequest) {
  let body: { question?: string };
  try {
    body = (await req.json()) as { question?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "assistant");
  if (limited) return limited;

  const question = body.question?.trim();
  if (!question) return NextResponse.json({ error: "question is required" }, { status: 400 });

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);
  const { ask } = await import("@/lib/platform/assistant");
  return NextResponse.json(await ask(merchantId, question));
}
