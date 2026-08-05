import { MonadMark } from "@/components/MonadMark";

/**
 * USDC brand mark — Circle's official coin: a #2775CA disc with the white
 * dollar glyph (vertical bar through a C-ring). Drawn from the published logo
 * geometry so it reads as real USDC at any size, not a generic dollar sign.
 */
export function UsdcMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 2000 2000" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <circle cx="1000" cy="1000" r="1000" fill="#2775CA" />
      <path d="M1275 1158.3c0-145.8-87.5-195.8-262.5-216.6-125-16.7-150-50-150-108.3s41.7-95.8 125-95.8c75 0 116.7 25 137.5 87.5 4.2 12.5 16.7 20.8 29.2 20.8h66.7c16.7 0 29.2-12.5 29.2-29.2v-4.2c-16.7-91.7-91.7-162.5-187.5-170.8v-100c0-16.7-12.5-29.2-33.3-33.3h-62.5c-16.7 0-29.2 12.5-33.3 33.3v95.8c-125 16.7-204.2 100-204.2 204.2 0 137.5 83.3 191.7 258.3 212.5 116.7 20.8 154.2 45.8 154.2 112.5s-58.3 112.5-137.5 112.5c-108.3 0-145.8-45.8-158.3-108.3-4.2-16.7-16.7-25-29.2-25h-70.8c-16.7 0-29.2 12.5-29.2 29.2v4.2c16.7 104.2 83.3 179.2 220.8 200v100c0 16.7 12.5 29.2 33.3 33.3h62.5c16.7 0 29.2-12.5 33.3-33.3v-100c125-20.8 208.3-108.3 208.3-220.9z" fill="#fff" />
      <path d="M787.5 1595.8c-325-116.7-491.7-479.2-370.8-800 62.5-175 200-308.3 370.8-370.8 16.7-8.3 25-20.8 25-41.7v-58.3c0-16.7-8.3-29.2-25-33.3-4.2 0-12.5 0-16.7 4.2-395.8 125-612.5 545.8-487.5 941.7 75 233.3 254.2 412.5 487.5 487.5 16.7 8.3 33.3 0 37.5-16.7 4.2-4.2 4.2-8.3 4.2-16.7v-58.3c0-12.5-12.5-29.2-25-37.5zM1229.2 300c-16.7-8.3-33.3 0-37.5 16.7-4.2 4.2-4.2 8.3-4.2 16.7v58.3c0 16.7 12.5 33.3 25 41.7 325 116.7 491.7 479.2 370.8 800-62.5 175-200 308.3-370.8 370.8-16.7 8.3-25 20.8-25 41.7v58.3c0 16.7 8.3 29.2 25 33.3 4.2 0 12.5 0 16.7-4.2 395.8-125 612.5-545.8 487.5-941.7-75-237.5-258.3-416.7-487.5-491.6z" fill="#fff" />
    </svg>
  );
}

/** Deterministic, tasteful fill color for an unknown token's fallback badge —
 *  same symbol always gets the same color, so it's recognizable at a glance
 *  without ever fabricating a logo that isn't real. */
function fallbackColor(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 55% 45%)`;
}

/** Generic coin badge for a token with no known brand mark — the honest
 *  fallback for "any fungible token on Monad" instead of a fake logo. */
export function GenericTokenMark({ symbol, size = 14, className = "" }: { symbol: string; size?: number; className?: string }) {
  const initial = symbol.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.52, background: fallbackColor(symbol) }}
    >
      {initial}
    </span>
  );
}

/**
 * The right coin logo for a token. Known brand marks (MON, USDC family) get
 * their real drawn logo; a curated `logoURI` renders as an image (falling
 * back to the generic badge if it fails to load); anything else gets the
 * deterministic generic badge — never nothing, and never a fabricated icon.
 */
export function TokenLogo({ token, size = 14, className = "", logoURI }: { token: string; size?: number; className?: string; logoURI?: string | null }) {
  if (token === "MON") return <MonadMark size={size} className={className} />;
  if (token === "USDC" || token === "USDT" || token === "USD") return <UsdcMark size={size} className={className} />;
  if (logoURI) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoURI}
        alt=""
        width={size}
        height={size}
        className={`rounded-full ${className}`}
        onError={(e) => { e.currentTarget.style.display = "none"; }}
      />
    );
  }
  return <GenericTokenMark symbol={token} size={size} className={className} />;
}

/**
 * Full precision up to five figures, then compact.
 *
 * A metric card is a fixed width and volume only ever grows, so a number
 * formatted to please today's total eventually runs out of room. Past 10,000
 * the extra digits stop being information anyone reads at a glance and start
 * being the thing that breaks the layout, so they collapse to "12.4K". Below
 * that nothing is abbreviated — early totals are small, and rounding them
 * would make the platform look emptier than it is.
 */
export function formatVolumeAmount(v: number): string {
  if (v >= 10_000) return v.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * The same per-token volume, one token per row.
 *
 * Every nonzero asset shown separately — never blended into one misleading
 * number, since 1 MON + 1 USDC is not 2 of anything.
 *
 * Built for metric cards, where the container is narrow and fixed: the logo
 * and symbol hold their size, the number gives way first, and the row can
 * shrink to nothing without any of it escaping the card. This replaced an
 * inline one-line variant that could not do that — its token groups had no
 * `min-width: 0`, so two currencies in a one-third column rendered straight
 * over whatever sat beside them, which is exactly what the landing page's
 * dashboard preview was doing.
 *
 * `max` caps the visible rows and states how many are left rather than
 * dropping them silently, so a wallet holding six assets does not stretch a
 * card built for two.
 */
export function VolumeStack({
  byToken,
  size = 14,
  max,
  valueClassName = "text-sm font-semibold",
  className = "",
}: {
  byToken: Record<string, number>;
  size?: number;
  max?: number;
  valueClassName?: string;
  className?: string;
}) {
  const parts = Object.entries(byToken).filter(([, v]) => v > 0);
  // Inherits the surrounding metric's type — the dash is the metric, so it
  // should be set at whatever size that metric is, not at the row size.
  if (!parts.length) return <span>—</span>;

  const shown = max ? parts.slice(0, max) : parts;
  const hidden = parts.length - shown.length;

  return (
    <div className={`min-w-0 space-y-1 ${className}`}>
      {shown.map(([token, v]) => (
        <div key={token} className="flex min-w-0 items-center gap-1.5">
          <TokenLogo token={token} size={size} className="shrink-0" />
          {/* title carries the exact figure, since the visible one may be
              compacted or truncated. */}
          <span
            title={`${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${token}`}
            className={`truncate tabular-nums tracking-tight text-foreground ${valueClassName}`}
          >
            {formatVolumeAmount(v)}
          </span>
          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">{token}</span>
        </div>
      ))}
      {hidden > 0 && (
        <p className="text-[10px] text-muted-foreground">+{hidden} more {hidden === 1 ? "asset" : "assets"}</p>
      )}
    </div>
  );
}
