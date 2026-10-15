import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { THEME_SCRIPT, cookieDomainFor, isThemeChoice } from "@/lib/theme";

/** Runs the pre-paint script against a stub page and returns what it set. */
function runScript({ cookie = "", stored = null as string | null, prefersLight = false, storageThrows = false } = {}) {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const ctx = {
    document: { cookie, documentElement: root },
    localStorage: { getItem: () => { if (storageThrows) throw new Error("blocked"); return stored; } },
    window: { matchMedia: (q: string) => ({ matches: prefersLight && q.includes("light") }) },
    matchMedia: (q: string) => ({ matches: prefersLight && q.includes("light") }),
  };
  vm.runInNewContext(THEME_SCRIPT, ctx);
  return { theme: root.dataset.theme, scheme: root.style.colorScheme };
}

describe("the pre-paint theme script", () => {
  it("defaults to dark — the current look stays the default", () => {
    expect(runScript()).toEqual({ theme: "dark", scheme: "dark" });
  });
  it("applies a saved light choice from the cookie", () => {
    expect(runScript({ cookie: "a=1; payai-theme=light; b=2" }).theme).toBe("light");
  });
  it("falls back to localStorage when there is no cookie", () => {
    expect(runScript({ stored: "light" }).theme).toBe("light");
  });
  it("follows the device for 'system'", () => {
    expect(runScript({ cookie: "payai-theme=system", prefersLight: true }).theme).toBe("light");
    expect(runScript({ cookie: "payai-theme=system", prefersLight: false }).theme).toBe("dark");
  });
  it("ignores garbage and never throws, even with storage blocked", () => {
    expect(runScript({ cookie: "payai-theme=<script>", stored: "neon" }).theme).toBe("dark");
    expect(runScript({ storageThrows: true }).theme).toBe("dark");
  });
});

describe("theme choice helpers", () => {
  it("shares the choice across every PayAI host, and only those", () => {
    for (const h of ["usepayai.xyz", "app.usepayai.xyz", "docs.usepayai.xyz"]) expect(cookieDomainFor(h)).toBe(".usepayai.xyz");
    for (const h of ["localhost", "veripayai.vercel.app", "usepayai.xyz.evil.com", "notusepayai.xyz"]) expect(cookieDomainFor(h)).toBeNull();
  });
  it("accepts only the three choices", () => {
    expect(["light", "dark", "system"].every(isThemeChoice)).toBe(true);
    expect(isThemeChoice("blue")).toBe(false);
  });
});

describe("light mode tokens", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
  const vars = (s: string) => new Set([...s.matchAll(/--([\w-]+):/g)].map((m) => m[1]));
  it("redefines every colour token the dark canvas defines", () => {
    const dark = [...vars(block(":root {"))].filter((v) => v !== "safe-area-inset-bottom");
    const light = vars(block(':root[data-theme="light"]'));
    for (const v of dark) expect(light.has(v), v).toBe(true);
  });
  it("keeps the PayAI purple identical in both", () => {
    const p = (s: string) => s.match(/--primary:\s*([^;]+);/)?.[1];
    expect(p(block(':root[data-theme="light"]'))).toBe(p(block(":root {")));
  });
});

describe("no component hardcodes a dark-only overlay", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".tsx")) files.push(p); } };
  walk("app"); walk("components");
  it("translucent borders/fills use the theme-aware glass token, not literal white", () => {
    const bad = files.filter((f) => /\b(border|bg|ring)-white\//.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
});
