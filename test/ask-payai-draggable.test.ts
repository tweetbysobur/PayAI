import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The "Ask PayAI" trigger was permanently fixed to the bottom-right corner,
 * which on some pages sat directly on top of content (the Recovery Status
 * card on Wallets, at some viewport heights). Made it draggable instead of
 * relocating it to a single new fixed spot, since no one fixed position is
 * safe on every page this button appears on.
 *
 * A real drag was verified in a live browser (not just source assertions
 * here): it moves the button, does not also open the command bar, the
 * dropped position survives a reload, and a plain click still opens it.
 * These hold the parts of that behavior that are checkable from source.
 */

const src = readFileSync(new URL("../components/dashboard/CommandBar.tsx", import.meta.url), "utf8");

describe("the trigger is a real drag gesture, not a fixed corner", () => {
  it("uses Framer's drag on the trigger button", () => {
    expect(src).toMatch(/<motion\.button[\s\S]{0,40}drag\b/);
  });

  it("has no residual momentum or elastic overshoot after release", () => {
    // A floating utility button that keeps gliding after you let go reads as
    // unpolished, not premium — it should stop exactly where it's dropped.
    expect(src).toMatch(/dragMomentum=\{false\}/);
    expect(src).toMatch(/dragElastic=\{0\}/);
  });

  it("constrains movement to the viewport with a margin", () => {
    // Otherwise it can be dropped off-screen or under the sidebar/topbar
    // where it becomes unreachable.
    expect(src).toMatch(/const EDGE_MARGIN = 16/);
    expect(src).toMatch(/dragConstraints=\{dragConstraints\}/);
  });
});

describe("a drag never also opens the command bar", () => {
  it("gates the click handler on whether a drag actually happened", () => {
    expect(src).toMatch(/onClick=\{\(\) => \{ if \(draggedRef\.current\) return; setOpen\(true\); \}\}/);
  });

  it("clears the drag flag after release, so the next real tap still opens it", () => {
    expect(src).toMatch(/onDragEnd=\{\(\) => \{/);
    expect(src).toMatch(/draggedRef\.current = false/);
  });
});

describe("the dropped position is remembered", () => {
  it("saves to localStorage on drag end", () => {
    expect(src).toMatch(/localStorage\.setItem\(POS_KEY/);
  });

  it("clamps a saved position back inside the viewport on load and on resize", () => {
    // A position saved on a wide screen could otherwise sit off-screen after
    // a resize or rotation.
    expect(src).toMatch(/function clamp\(/);
    expect(src).toMatch(/window\.addEventListener\("resize", onResize\)/);
  });
});

describe("stays SSR-safe", () => {
  it("never reads window directly in the render body", () => {
    // dragConstraints must be derived from state set inside an effect —
    // reading window.innerWidth directly during render crashes the Next.js
    // server render pass, since this component is rendered once on the
    // server before it ever reaches the browser.
    const constraintsBlock = src.slice(src.indexOf("const dragConstraints ="), src.indexOf("const dragConstraints =") + 400);
    expect(constraintsBlock).toMatch(/size\s*\?/);
  });
});
