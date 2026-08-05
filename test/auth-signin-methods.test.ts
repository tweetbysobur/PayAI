import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The sign-in screen used to render Google/Apple/X as visible, disabled
 * buttons with a "Soon" badge whenever a deployment had no credentials for
 * them — which is every deployment today, since AUTH_SESSION_SECRET isn't
 * set. A greyed-out button is still an offer; it just moves the
 * disappointment to the moment someone clicks it.
 *
 * The fix removes the method from the page entirely rather than disabling
 * it, the same rule the landing page's EmbeddedWalletSection already
 * follows. These tests hold that rule on /auth specifically, since that's
 * the actual sign-in flow rather than a marketing preview of it.
 */

const source = readFileSync(new URL("../app/auth/page.tsx", import.meta.url), "utf8");

describe("unconfigured sign-in methods are absent, not disabled", () => {
  it("filters the social row to configured methods before rendering", () => {
    expect(source).toMatch(/\.filter\(\(s\) => wallet\.authMethods\[s\.method\]\)/);
  });

  it("no longer renders a disabled button or a Soon badge for social sign-in", () => {
    expect(source).not.toMatch(/disabled=\{!s\.available/);
    expect(source).not.toMatch(/>Soon</);
  });

  it("hides the email row too when email sign-in isn't configured", () => {
    expect(source).toMatch(/emailAvailable && \(/);
  });

  it("hides the entire divider when no alternate sign-in exists at all", () => {
    // Otherwise a passkey-only deployment shows "or continue with" above an
    // empty space — a divider that introduces nothing.
    expect(source).toMatch(/hasAlternateSignIn && \(/);
  });

  it("does not claim a method by name in the collapsible why-list unless it is offered", () => {
    // The old copy hardcoded "Sign in with Google, Apple, X or Email" —
    // exactly as false as the disabled buttons it sat below.
    expect(source).not.toMatch(/"Sign in with Google, Apple, X or Email"/);
    expect(source).toMatch(/alternateNames\.join/);
  });
});
