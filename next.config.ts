import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  // Don't advertise the framework.
  poweredByHeader: false,
  // Strip console.* (except error/warn) from the production client bundle.
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
  // Security headers on every response. Most important for a wallet app:
  // X-Frame-Options DENY prevents the site being iframed for a clickjacking
  // attack that tricks users into approving transactions.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // publickey-credentials-get is what the embedded wallet's passkey
          // ceremony needs; it is same-origin only, which is what we want.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self)",
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
        ],
      },
    ];
  },
};

/**
 * Content-Security-Policy.
 *
 * The embedded wallet keeps a live private key in the page, so injected
 * script is the worst realistic threat: it wouldn't need to steal a seed
 * phrase, it could just sign. `connect-src` is the directive that actually
 * matters here — it pins network access to this origin plus the Monad RPCs,
 * so injected code cannot fetch/XHR/WebSocket a key out to an attacker's
 * server. `object-src`, `base-uri` and `form-action` close the classic
 * side-channels, and `frame-ancestors` backstops X-Frame-Options.
 *
 * Two honest limitations, stated rather than implied away:
 *   - `script-src` keeps 'unsafe-inline' because Next's App Router injects
 *     inline bootstrap scripts and this project has no nonce middleware.
 *     That weakens CSP as an XSS *prevention*, which is why connect-src is
 *     carrying the weight as XSS *containment*.
 *   - `img-src` allows https: because token logos come from arbitrary
 *     registry URLs, and an image request is a possible exfiltration
 *     channel. Closing it means pinning or proxying token logos first.
 *
 * RPC hosts are read from the same public env the client uses, so adding a
 * backup RPC doesn't silently break under CSP.
 */
function contentSecurityPolicy(): string {
  const rpcOrigins = [
    process.env.NEXT_PUBLIC_MONAD_RPC || "https://testnet-rpc.monad.xyz",
    ...(process.env.NEXT_PUBLIC_MONAD_RPC_BACKUP || "").split(","),
  ]
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => {
      try {
        return new URL(u).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const analytics = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID
    ? ["https://www.googletagmanager.com", "https://www.google-analytics.com"]
    : [];
  // WalletConnect's relay is only reachable when the feature is switched on.
  const walletConnect = process.env.NEXT_PUBLIC_WC_PROJECT_ID
    ? ["https://*.walletconnect.com", "https://*.walletconnect.org", "wss://*.walletconnect.com", "wss://*.walletconnect.org"]
    : [];

  const connect = ["'self'", ...new Set(rpcOrigins), ...analytics, ...walletConnect];

  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${analytics.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export default nextConfig;
