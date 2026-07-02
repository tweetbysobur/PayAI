#!/usr/bin/env node
/**
 * Post a weekly update to the DeltaV startup profile from real git history.
 *
 * Safe by design:
 *   - DRAFT by default — prints the update and posts NOTHING. Add --post to send.
 *   - Content is generated ONLY from real commits (never fabricated progress).
 *   - The API key is read from DELTAV_API_KEY (env or .env.local) and is never
 *     logged. Override the generated text with --content / --file when you want.
 *
 * Usage:
 *   node scripts/deltav-update.mjs                 # draft from the last 7 days
 *   node scripts/deltav-update.mjs --days 7        # change the window
 *   node scripts/deltav-update.mjs --file note.txt # use your own text
 *   node scripts/deltav-update.mjs --x https://x.com/AskPayAI/status/123
 *   node scripts/deltav-update.mjs --post          # actually post it
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const API_URL = "https://deltav.monad.xyz/api/v1/weekly-updates";

/* ── args ──────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const val = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const POST = flag("post");
const DAYS = Number(val("days") || "7");
const X_LINK = val("x");

/* ── load DELTAV_API_KEY from env or .env.local (never printed) ─────────── */
function loadKey() {
  if (process.env.DELTAV_API_KEY) return process.env.DELTAV_API_KEY.trim();
  if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*DELTAV_API_KEY\s*=\s*(.*)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

/* ── build the update from real commits ────────────────────────────────── */
const SECTIONS = [
  { key: "launch", title: "🚀 Launched", match: (s) => /\blaunch|\bgo[- ]?live|domain\b/i.test(s) },
  { key: "feat", title: "✨ Shipped", match: (s) => /^feat/i.test(s) },
  { key: "security", title: "🔒 Security & privacy", match: (s) => /^(security|fix).*(auth|privacy|leak|wallet|expos)/i.test(s) || /^security/i.test(s) },
  { key: "fix", title: "🔧 Fixes", match: (s) => /^fix/i.test(s) },
  { key: "quality", title: "🧱 Quality & infra", match: (s) => /^(test|ci|chore|build|perf)/i.test(s) },
  { key: "docs", title: "📝 Docs & polish", match: (s) => /^(docs|copy|refactor|style)/i.test(s) },
];

function clean(subject) {
  return subject
    .replace(/^[a-z]+(\([^)]*\))?:\s*/i, "") // strip "type(scope): "
    .replace(/\s+—.*$/, "")                  // drop trailing " — detail"
    .replace(/\s+\(.*\)$/, "")               // drop trailing "(...)"
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function buildContent() {
  const raw = execSync(`git log --since="${DAYS} days ago" --pretty=%s`, { encoding: "utf8" })
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  if (!raw.length) return null;

  const used = new Set();
  const buckets = new Map();
  for (const s of raw) {
    const sec = SECTIONS.find((x) => x.match(s));
    if (!sec) continue;
    const line = clean(s);
    const dedupeKey = sec.key + "|" + line.toLowerCase();
    if (used.has(dedupeKey)) continue;
    used.add(dedupeKey);
    if (!buckets.has(sec.key)) buckets.set(sec.key, []);
    buckets.get(sec.key).push(line);
  }

  const out = ["Shipped this week:", ""];
  for (const sec of SECTIONS) {
    const items = buckets.get(sec.key);
    if (!items?.length) continue;
    out.push(sec.title);
    for (const it of items.slice(0, 8)) out.push(`- ${it}`);
    out.push("");
  }
  return out.join("\n").trim();
}

/* ── resolve content ───────────────────────────────────────────────────── */
let content;
if (val("file")) content = readFileSync(val("file"), "utf8").trim();
else if (val("content")) content = val("content");
else content = buildContent();

if (!content) {
  console.error("No commits found in the window and no --content/--file given. Nothing to post.");
  process.exit(1);
}

/* ── output / post ─────────────────────────────────────────────────────── */
console.log("\n──────── DeltaV weekly update ────────\n");
console.log(content);
if (X_LINK) console.log(`\n[xLink] ${X_LINK}`);
console.log(`\n(${content.length} chars)\n──────────────────────────────────────\n`);

if (!POST) {
  console.log("DRAFT — nothing was posted. Re-run with --post to publish it.");
  process.exit(0);
}

const key = loadKey();
if (!key) {
  console.error("DELTAV_API_KEY not found in env or .env.local. Cannot post.");
  process.exit(1);
}

const body = { content };
if (X_LINK) body.xLink = X_LINK;

const res = await fetch(API_URL, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const text = await res.text();
if (res.ok) {
  console.log(`✅ Posted to DeltaV (HTTP ${res.status}).`);
} else {
  console.error(`❌ DeltaV rejected the update (HTTP ${res.status}):`);
  console.error(text.slice(0, 500));
  process.exit(1);
}
