/**
 * PayAI brand mark — "The Single Notch": one closed circle with exactly one
 * asymmetric wedge cut from its edge, the two cut edges meeting at the
 * circle's center. The closed form reads as containment/security (a seal,
 * a vault); the angle and asymmetry of the cut carry direction/momentum.
 * No letters are drawn — P and A only shaped the cut's proportions.
 *
 * Geometry (32x32 viewBox, center 16,16, radius 11): the wedge spans 44°
 * centered on -45° (upper-right, "forward" direction), computed from
 * cos/sin rather than eyeballed, so the cut stays precise at any scale.
 */
const NOTCH_PATH = "M20.65 6.03 L16 16 L25.97 11.35 A11 11 0 1 1 20.65 6.03 Z";

/** Bare symbol — for favicons, app icons, social avatars: no container chip. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d={NOTCH_PATH} fill="currentColor" />
    </svg>
  );
}

/**
 * Lockup chip — the mark on a rounded-square purple tile, used wherever the
 * mark sits inline with the wordmark (nav, sidebar). `mono` drops the tile
 * and renders the bare mark in the current text color instead.
 */
export function Logo({ size = 32, className = "", mono = false }: { size?: number; className?: string; mono?: boolean }) {
  if (mono) return <LogoMark size={size} className={className} />;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="8" fill="currentColor" className="text-primary-ink" />
      <path d={NOTCH_PATH} fill="white" />
    </svg>
  );
}
