/**
 * Ask PayAI mark — the sub-brand for the conversational surface.
 *
 * Ask PayAI had no mark of its own. Every surface that identified it — the
 * workspace header, the empty state, the assistant avatar on every reply, the
 * thinking row, the ⌘K bar, the sidebar entry — rendered lucide's `Sparkles`,
 * the default "there is an AI here" glyph shipped in thousands of products. It
 * said "generic assistant", not "PayAI".
 *
 * ── The parent mark, kept whole ─────────────────────────────────────────────
 * components/Logo.tsx ("The Single Notch") is a closed circle of radius 11 on a
 * 32x32 field with one wedge cut inward to the center. The wedge is not
 * eyeballed: it spans exactly 40°, centered on -45° (edges at -65° and -25°),
 * re-derived from the committed path rather than trusted from its comment.
 *
 * This mark does not modify any of that. The circle, the center, the radius and
 * the notch are byte-for-byte the parent's. The only addition is a speech tail
 * at 135° — the diagonally opposite corner — spanning 28° and reaching radius
 * 17. Ask PayAI is therefore the PayAI seal, speaking: the parent is fully
 * present and the child is unmistakable, which is what a sub-brand has to do.
 *
 * Putting the tail opposite the notch is the load-bearing choice. The two
 * features never touch, so the silhouette stays legible instead of merging.
 *
 * ── Why not the more elegant idea ───────────────────────────────────────────
 * The first attempt was cleaner on paper: reuse the parent's exact 40° wedge
 * but invert it, pointing out instead of cutting in — one shape, one operation
 * flipped. Rendered, it failed. A 40° wedge reads as a decisive slice when
 * removed and as a lump when added; the mark came out as a droplet or an apple
 * and lost the parent's crispness entirely. Narrowing the outward wedge to
 * 15-26° and extending it fixed the blobbiness but produced a pin or a balloon
 * — nothing to do with speech, and the spike went fragile at 13px. Both were
 * checked by rendering them side by side with the parent at 56/32/20/16/13px
 * and looking, not by reasoning about the geometry.
 *
 * ── Why one path ────────────────────────────────────────────────────────────
 * The mark renders at 13px in a chat avatar, which is the size that decides
 * whether a mark works at all. A single closed silhouette survives that; a
 * glyph plus a floating accent does not. Tail and circle are unioned into one
 * continuous path — no strokes, no gaps, no second element — so it scales from
 * one viewBox to any size.
 */

/**
 * Circle center (16,16), r=11.
 *   - Notch: the parent's own wedge, -65° to -25°, cut in to the center.
 *   - Tail:  135° ± 14°, apex pushed out to r=17.
 */
const ASK_PATH =
  "M20.65 6.03 L16 16 L25.97 11.35 A11 11 0 0 1 10.33 25.43 L3.98 28.02 L6.57 21.67 A11 11 0 0 1 20.65 6.03 Z";

/**
 * The bare mark, inheriting the current text color — the form used almost
 * everywhere Ask PayAI identifies itself (avatar chips, sidebar nav, the ⌘K
 * trigger), since each of those already supplies its own background.
 */
export function AskMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ASK_PATH} fill="currentColor" />
    </svg>
  );
}

/**
 * Chip lockup — the mark reversed out of a filled rounded-square tile, matching
 * the parent Logo()'s chip exactly in radius and proportion. For the places that
 * present Ask PayAI as a product rather than label a message, i.e. the
 * workspace hero.
 */
export function AskLogo({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path d={ASK_PATH} fill="white" />
    </svg>
  );
}
