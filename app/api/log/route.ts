import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/log — sink for client-side error reports (from the error
 * boundaries). Emits one structured line to stderr so client crashes are
 * captured in the same place as server errors (Vercel logs). Rate-limited and
 * size-bounded so it can't be used to stuff the logs.
 */
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "write");
  if (limited) return limited;

  let body: { message?: string; stack?: string; digest?: string; where?: string; url?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  console.error(
    JSON.stringify({
      level: "error",
      kind: "client_error",
      at: new Date().toISOString(),
      where: String(body.where ?? "").slice(0, 60),
      url: String(body.url ?? "").slice(0, 200),
      digest: String(body.digest ?? "").slice(0, 60),
      message: String(body.message ?? "").slice(0, 500),
      stack: String(body.stack ?? "").slice(0, 2000),
    }),
  );

  return NextResponse.json({ ok: true });
}
