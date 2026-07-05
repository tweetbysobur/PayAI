"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary: catches errors thrown in the root layout itself (which
 * app/error.tsx can't, since it renders inside that layout). It must supply its
 * own <html>/<body>. Kept dependency-free and inline-styled so it renders even
 * if the styling/layer that failed is what broke.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    fetch("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ where: "global_error_boundary", message: error.message, stack: error.stack, digest: error.digest }),
    }).catch(() => {});
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#09090b", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px", textAlign: "center" }}>
          <h1 style={{ fontSize: "20px", fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ marginTop: "8px", color: "#a1a1aa", fontSize: "14px", maxWidth: "360px" }}>
            PayAI hit an unexpected error. Your wallet and funds are safe.
          </p>
          <button
            onClick={reset}
            style={{ marginTop: "24px", background: "#7c3aed", color: "#fff", border: 0, borderRadius: "8px", padding: "10px 16px", fontSize: "14px", fontWeight: 500, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
