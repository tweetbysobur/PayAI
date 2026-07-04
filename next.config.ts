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
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

export default nextConfig;
