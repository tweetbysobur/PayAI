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

/** The right coin logo for a token symbol. Falls back to nothing for unknowns. */
export function TokenLogo({ token, size = 14, className = "" }: { token: string; size?: number; className?: string }) {
  if (token === "MON") return <MonadMark size={size} className={className} />;
  if (token === "USDC" || token === "USDT" || token === "USD") return <UsdcMark size={size} className={className} />;
  return null;
}

/**
 * Renders a per-token volume map as real coin logos + amounts:
 * "◆ 108.1 MON · $ 143 USDC". Every nonzero asset shown separately — never
 * blended into one misleading number. Empty map renders an em dash.
 */
export function VolumeInline({ byToken, size = 13, className = "" }: { byToken: Record<string, number>; size?: number; className?: string }) {
  const parts = Object.entries(byToken).filter(([, v]) => v > 0);
  if (!parts.length) return <span className={className}>—</span>;
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
      {parts.map(([token, v], i) => (
        <span key={token} className="inline-flex items-center gap-1">
          <TokenLogo token={token} size={size} />
          <span className="font-mono">{v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          <span className="text-muted-foreground">{token}</span>
          {i < parts.length - 1 && <span className="text-muted-foreground/40">·</span>}
        </span>
      ))}
    </span>
  );
}
