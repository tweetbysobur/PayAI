import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

/**
 * Client code must not reach into server-only modules.
 *
 * A `"use client"` module that imports one marked `import "server-only"` drags
 * the server's RPC client, its private-key handling and its KV credentials
 * into the browser bundle. Next catches it — but only during a full production
 * build, as a wall of Turbopack module-graph output that names the symptom
 * rather than the mistake. This catches it in about a second, and says which
 * file did it.
 *
 * It is a genuine near-miss: `usePortfolio` imported the native-token sentinel
 * from `lib/monad/tokenRegistry`, a constant with no server dependency of its
 * own, sitting in a server-only file. The constant moved to the browser-safe
 * config; this stops the next one.
 */

const ROOT = resolve(__dirname, "..");
const SCANNED = ["app", "components", "lib"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const files = SCANNED.flatMap((d) => walk(join(ROOT, d)));

/** Files that declare themselves server-only. */
const serverOnly = new Set(
  files.filter((f) => /^\s*import\s+["']server-only["']/m.test(readFileSync(f, "utf8"))),
);

/** Files that run in the browser. */
const clientFiles = files.filter((f) => {
  const head = readFileSync(f, "utf8").slice(0, 200);
  return /^\s*["']use client["']/.test(head);
});

/** Static `import ... from "…"` specifiers. Dynamic `await import()` is
 *  deliberately excluded: a client component may lazily pull a server module
 *  inside a server action, and those are resolved at a different boundary. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

/** Resolve an import specifier to a file this repo owns, or null. */
function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // a package, not ours

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (files.includes(candidate)) return candidate;
  }
  return null;
}

describe("server/client module boundary", () => {
  it("finds both kinds of module, so this test is actually looking at something", () => {
    // Guards the guard: a resolver change that silently matched nothing would
    // make every assertion below pass vacuously.
    expect(serverOnly.size).toBeGreaterThan(10);
    expect(clientFiles.length).toBeGreaterThan(10);
  });

  it("no client module statically imports a server-only module", () => {
    const violations: string[] = [];
    for (const file of clientFiles) {
      for (const spec of staticImports(readFileSync(file, "utf8"))) {
        const target = resolveLocal(file, spec);
        if (target && serverOnly.has(target)) {
          violations.push(`${relative(ROOT, file)} imports ${relative(ROOT, target)}`);
        }
      }
    }
    expect(violations, "server-only code would be bundled into the browser").toEqual([]);
  });
});
