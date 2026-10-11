import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Ask PayAI had no mark of its own — every surface that identified it rendered
 * lucide's `Sparkles`, the same "there is an AI here" glyph thousands of other
 * products ship. components/AskMark.tsx gives it one, built from the PayAI mark
 * rather than beside it: the parent's circle and notch are kept byte-for-byte
 * and a speech tail is added at the diagonally opposite corner.
 *
 * That shared geometry is the entire sub-brand relationship, and nothing else
 * enforces it — the two marks are separate files, so an edit to either silently
 * breaks the family resemblance with no visible failure anywhere. These tests
 * are the enforcement. Source-level, matching this repo's existing approach for
 * component assertions (see wallets-hero-card.test.ts).
 */

const askSrc = readFileSync(new URL("../components/AskMark.tsx", import.meta.url), "utf8");
const logoSrc = readFileSync(new URL("../components/Logo.tsx", import.meta.url), "utf8");

function pathOf(src: string, constName: string): string {
  // Both files declare their geometry as a single string constant, possibly
  // wrapped onto the next line.
  const m = new RegExp(`const ${constName}\\s*=\\s*\\n?\\s*"([^"]+)"`).exec(src);
  if (!m) throw new Error(`could not find ${constName}`);
  return m[1];
}

const ASK_PATH = pathOf(askSrc, "ASK_PATH");
const NOTCH_PATH = pathOf(logoSrc, "NOTCH_PATH");

/**
 * Every absolute coordinate this path visits — the M/L points AND the endpoint
 * of each elliptical arc. Arc endpoints matter here: one of the two tail bases
 * is reached by an `A` command, so an M/L-only parser silently undercounts the
 * points sitting on the circle.
 */
function points(d: string): [number, number][] {
  const ml = [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)];
  const arcs = [...d.matchAll(/A[\d.]+\s+[\d.]+\s+\d+\s+\d+\s+\d+\s+(-?[\d.]+)\s+(-?[\d.]+)/g)];
  return [...ml, ...arcs].map((m) => [Number(m[1]), Number(m[2])]);
}
const dist = ([x, y]: [number, number]) => Math.hypot(x - 16, y - 16);

describe("the Ask PayAI mark is built from the PayAI mark", () => {
  it("keeps the parent's notch exactly — same start point, same cut to the centre, same second edge", () => {
    // The parent opens: circle edge at -65deg, in to the centre, out to -25deg.
    // Ask must reproduce that verbatim before it does anything of its own.
    const parentOpening = "M20.65 6.03 L16 16 L25.97 11.35 A11 11 0 ";
    expect(NOTCH_PATH.startsWith(parentOpening)).toBe(true);
    expect(ASK_PATH.startsWith(parentOpening)).toBe(true);
  });

  it("draws every arc on the parent's radius of 11", () => {
    const radii = [...ASK_PATH.matchAll(/A(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/g)].map((m) => [m[1], m[2]]);
    expect(radii.length).toBeGreaterThan(0);
    for (const [rx, ry] of radii) {
      expect(rx).toBe("11");
      expect(ry).toBe("11");
    }
  });

  it("puts the notch edges and the tail base on the circle, and only the tail apex outside it", () => {
    // Three kinds of point exist in this path: the centre (the notch apex),
    // points ON the circle (both notch edges, both tail bases), and the tail
    // apex beyond it. Anything else means the geometry drifted.
    const onCircle = points(ASK_PATH).filter((p) => Math.abs(dist(p) - 11) < 0.02);
    const atCentre = points(ASK_PATH).filter((p) => dist(p) < 0.02);
    const outside = points(ASK_PATH).filter((p) => dist(p) > 11.02);

    expect(atCentre).toHaveLength(1); // the notch cuts to the centre, once
    expect(onCircle.length).toBeGreaterThanOrEqual(4); // 2 notch edges + 2 tail bases
    expect(outside).toHaveLength(1); // exactly one tail, one apex
    expect(dist(outside[0])).toBeCloseTo(17, 1); // and it reaches r=17
  });

  it("keeps the tail clear of the notch so the silhouette never merges into a blob", () => {
    // The notch is centred on -45deg. A tail anywhere near it produced a
    // droplet in review; putting it at 135deg is what makes the mark legible
    // at 13px, which is the size the chat avatar actually renders.
    const apex = points(ASK_PATH).find((p) => dist(p) > 11.02)!;
    const deg = (Math.atan2(apex[1] - 16, apex[0] - 16) * 180) / Math.PI;
    expect(deg).toBeCloseTo(135, 0);
  });

  it("stays inside the 32x32 viewBox at every point, so nothing clips at any size", () => {
    for (const [x, y] of points(ASK_PATH)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(32);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(32);
    }
  });

  it("is one continuous filled path — no strokes, no second element", () => {
    // A composition of shapes disintegrates at avatar size; a single closed
    // silhouette does not.
    expect((ASK_PATH.match(/M/g) ?? []).length).toBe(1);
    expect(ASK_PATH.trimEnd().endsWith("Z")).toBe(true);
    expect(askSrc).not.toMatch(/stroke=/);
  });
});

describe("Ask PayAI identifies itself with its own mark, never a stock glyph", () => {
  const SURFACES = [
    "../components/ask/AskEmptyState.tsx",
    "../components/ask/ChatMessage.tsx",
    "../app/dashboard/ask/page.tsx",
    "../components/dashboard/CommandBar.tsx",
  ];

  for (const rel of SURFACES) {
    it(`${rel.split("/").pop()} uses AskMark/AskLogo and no longer imports Sparkles`, () => {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(src).toMatch(/from "@\/components\/AskMark"/);
      expect(src).not.toMatch(/\bSparkles\b/);
    });
  }

  it("the sidebar's Ask PayAI entry carries the mark", () => {
    const src = readFileSync(new URL("../components/dashboard/Sidebar.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/label: "Ask PayAI", icon: AskMark/);
  });
});

describe("the capability shortcuts still send only their label", () => {
  const src = readFileSync(new URL("../components/ask/AskEmptyState.tsx", import.meta.url), "utf8");

  it("the welcome screen fills the message box with a prompt — it never sends one", () => {
    // Its prompts carry example names (alice.nad, bob.nad). Sending one as is
    // would start a plan to pay someone the user never chose, so a pick only
    // fills the box (onFill) for the user to edit.
    const welcome = src.slice(src.indexOf("export function AskEmptyState("));
    expect(welcome).toMatch(/onClick=\{\(\) => pick\(s\.say\)\}/);
    expect(welcome).toMatch(/function pick\(text: string\) \{\s*onFill\(text\);/);
    expect(welcome).not.toMatch(/onPick|send\(|\.send\b/);
    for (const page of ["../app/dashboard/ask/page.tsx", "../components/dashboard/CommandBar.tsx"]) {
      const p = readFileSync(new URL(page, import.meta.url), "utf8");
      expect(p, page).toMatch(/<AskEmptyState onFill=\{(chat\.)?setInput\} \/>/);
    }
  });

  it("still offers all four on-ramps, phrased as spoken intents", () => {
    expect(src).toMatch(/label: "Send a payment"/);
    expect(src).toMatch(/label: "Trade a token"/);
    expect(src).toMatch(/label: "Automate a payment"/);
    expect(src).toMatch(/label: "Check my balance"/);
  });

  it("no longer says 'swap' — trade is the capability that handles buy/sell on any token", () => {
    expect(src).not.toMatch(/label: "Swap/);
  });

  it("the Trade hint describes scope, never a worked example with a figure in it", () => {
    // A concrete "buy $50 of X" reads as a command to copy rather than a
    // description of what the tile reaches, and it puts an arbitrary amount
    // in front of someone who hasn't chosen one yet — flagged directly against
    // this exact tile. Matches the register of the other three hints (Automate:
    // "Set it once, it runs on its own.", Check balance: "See everything your
    // wallet holds.") — describing what happens, not what to type.
    expect(src).toMatch(/label: "Trade a token", hint: "[^"]*"/);
    const hint = /label: "Trade a token", hint: "([^"]*)"/.exec(src)?.[1] ?? "";
    expect(hint).not.toMatch(/\$\d/);
    expect(hint).not.toMatch(/\bTry:/i);
  });
});

describe("every shortcut label is actually understood, not just nice copy", () => {
  // The tiles send their label through the real pipeline. Copy that reads well
  // but classifies as `unclear` is a dead end on the product's first screen —
  // which is exactly what "Swap tokens" turned out to be. These run the real
  // classifier with no API key, i.e. the WORST case (production reaches
  // Anthropic for all of these), so passing here means passing everywhere.
  const LABELS: [string, string][] = [
    ["Send a payment", "send_payment"],
    ["Trade a token", "trade"],
    ["Automate a payment", "schedule_payment"],
    ["Check my balance", "wallet_balance"],
  ];

  for (const [label, kind] of LABELS) {
    it(`"${label}" resolves to ${kind}, never unclear`, async () => {
      const { understand } = await import("@/lib/ask/intent/classify");
      const u = await understand(label, [], null);
      expect(u.kind).toBe(kind);
      expect(u.outcome).not.toBe("unclear");
    });
  }

  it("teaching the fallback these two words did not swallow neighbouring phrasings", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    // `automate` must not catch automation LISTING, and the anchored trade
    // clause must not catch tradability or market questions. None of these may
    // become a money-moving intent.
    for (const text of [
      "show my automations",
      "pause my automation",
      "can I trade it?",
      "is this tradable?",
      "what is the trade volume?",
    ]) {
      const u = await understand(text, [], null);
      expect(["trade", "swap", "send_payment", "schedule_payment"]).not.toContain(u.kind);
    }
  });
});
