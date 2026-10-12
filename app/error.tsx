"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RefreshCw, Home } from "lucide-react";
import { Logo } from "@/components/Logo";
import { CHUNK_RELOAD_KEY, isChunkLoadError, mayAutoReload } from "@/lib/platform/chunkReload";

/**
 * Route-level error boundary. Any uncaught render error in the app shows this
 * recovery screen instead of a white page, and reports itself to /api/log so
 * the crash is captured server-side (not just lost in the user's browser).
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isChunkLoadError(error);
  useEffect(() => {
    // A new version was deployed while this tab was open: reload once to get it.
    if (stale) {
      try {
        const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY));
        if (mayAutoReload(last || null, Date.now())) {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
          location.reload();
          return;
        }
      } catch {
        /* storage blocked — fall through to the screen and its reload button */
      }
    }
    fetch("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        where: "client_error_boundary",
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        url: typeof location !== "undefined" ? location.pathname : undefined,
      }),
    }).catch(() => {});
  }, [error, stale]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <Logo size={40} className="mb-6" />
      <h1 className="text-xl font-semibold tracking-tight text-foreground">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {stale
          ? "PayAI was updated while this page was open. Reload to get the latest version — your wallet and funds are safe."
          : "An unexpected error interrupted this page. Your wallet and funds are safe. Try again, or head back home."}
      </p>
      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={() => (stale ? location.reload() : reset())}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <RefreshCw size={15} /> Try again
        </button>
        <Link
          href="/dashboard"
          className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm text-foreground transition hover:bg-input"
        >
          <Home size={15} /> Dashboard
        </Link>
      </div>
      {error.digest && <p className="mt-6 font-mono text-[11px] text-muted-foreground/60">Reference: {error.digest}</p>}
    </div>
  );
}
