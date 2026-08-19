import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Invoices is being reworked, so it's gated off two ways -- matching exactly
 * how Ask PayAI's own COMING_SOON toggle (app/dashboard/ask/page.tsx) already
 * does this, rather than inventing a second pattern.
 *
 * The real workspace (payment links, on-chain payment requests -- fully built
 * and working) is left completely untouched: this only decides which
 * component renders, so flipping COMING_SOON back is the entire re-launch.
 */

const pageSrc = readFileSync(new URL("../app/dashboard/invoices/page.tsx", import.meta.url), "utf8");
const sidebarSrc = readFileSync(new URL("../components/dashboard/Sidebar.tsx", import.meta.url), "utf8");

describe("Invoices is off, both from the sidebar and from a direct URL", () => {
  it("the sidebar entry carries soon: true, so the nav link disables itself", () => {
    expect(sidebarSrc).toMatch(/\{ href: "\/dashboard\/invoices", label: "Invoices"[^}]*soon: true \}/);
  });

  it("the page itself gates on COMING_SOON = true, not just the nav badge", () => {
    // A bookmarked or typed URL reaches the route directly, past any sidebar
    // state -- the page has to refuse on its own.
    expect(pageSrc).toMatch(/const COMING_SOON = true;/);
    expect(pageSrc).toMatch(/return COMING_SOON \? <InvoicesComingSoon \/> : <InvoicesWorkspace \/>;/);
  });

  it("the real invoicing workspace still exists intact, just unreachable while COMING_SOON is true", () => {
    // Its own real logic (payment links + on-chain requests) is untouched --
    // proof this is a gate, not a deletion.
    expect(pageSrc).toMatch(/function InvoicesWorkspace\(\)/);
    expect(pageSrc).toMatch(/Create payment link/);
    expect(pageSrc).toMatch(/On-chain payment requests/);
  });

  it("the placeholder never claims a specific return date", () => {
    const placeholder = /function InvoicesComingSoon\(\)[\s\S]*?\n\}/.exec(pageSrc)?.[0] ?? "";
    expect(placeholder).not.toMatch(/\d{4}|\bnext week\b|\bnext month\b/i);
  });
});
