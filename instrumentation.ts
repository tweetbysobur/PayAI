/**
 * Central server-side error capture. Next.js calls onRequestError for every
 * uncaught error in a route handler, server component, or middleware — so this
 * is the one place every backend failure funnels through.
 *
 * We emit a single structured JSON line to stderr, which Vercel captures and
 * makes searchable/alertable via log drains. This is the integration seam: to
 * forward to Sentry / Logtail / Datadog, add the client call here (gated on a
 * DSN env var) without touching any route.
 */
type RequestInfo = { path?: string; method?: string };
type ErrorContext = { routerKind?: string; routePath?: string; routeType?: string };

export async function onRequestError(error: unknown, request: RequestInfo, context: ErrorContext) {
  const e = error as Error;
  try {
    console.error(
      JSON.stringify({
        level: "error",
        kind: "server_request_error",
        at: new Date().toISOString(),
        message: e?.message ?? String(error),
        stack: e?.stack?.slice(0, 4000),
        path: request?.path,
        method: request?.method,
        routeType: context?.routeType,
        routePath: context?.routePath,
      }),
    );
  } catch {
    // Never let error reporting throw and mask the original error.
    console.error("onRequestError:", e?.message ?? error);
  }
}
