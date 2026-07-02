import { ImageResponse } from "next/og";

// Branded social-share card (Open Graph + Twitter). Rendered at request time by
// next/og — this is the preview investors, Telegram, X, and grant reviewers see
// when the link is shared. Mirrors the app: deep navy canvas, purple PayAI mark.
export const runtime = "edge";
export const alt = "PayAI — AI-powered payments on Monad";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #0b0f17 0%, #12102b 100%)",
          padding: "72px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Brand row */}
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "72px",
              height: "72px",
              borderRadius: "18px",
              background: "#7C3AED",
            }}
          >
            <svg width="46" height="46" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M20.65 6.03 L16 16 L25.97 11.35 A11 11 0 1 1 20.65 6.03 Z" fill="white" />
            </svg>
          </div>
          <span style={{ color: "white", fontSize: "40px", fontWeight: 700, letterSpacing: "-0.02em" }}>PayAI</span>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div style={{ display: "flex", flexDirection: "column", color: "white", fontSize: "76px", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.05 }}>
            <div>Pay on Monad by</div>
            <div>typing what you want.</div>
          </div>
          <div style={{ color: "#9aa3b2", fontSize: "32px", lineHeight: 1.3, maxWidth: "900px" }}>
            Send, swap, and schedule payments just by describing them.
          </div>
        </div>

        {/* Footer chips */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          {["You stay in control", "Arrives in seconds", "Built on Monad"].map((t) => (
            <div
              key={t}
              style={{
                display: "flex",
                color: "#c9cfda",
                fontSize: "24px",
                border: "1px solid #26304a",
                borderRadius: "999px",
                padding: "10px 22px",
                background: "rgba(124,58,237,0.08)",
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
