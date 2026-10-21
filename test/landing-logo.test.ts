import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { landingHref } from "@/lib/hooks/useLandingHref";

/** The PayAI logo always leads to the landing page. On the app host "/"
 *  redirects to /dashboard, so the logo there must name the landing origin. */
describe("logo → landing page", () => {
  it("uses the full landing URL on the app and docs hosts, '/' elsewhere", () => {
    expect(landingHref("app.usepayai.xyz")).toBe("https://usepayai.xyz/");
    expect(landingHref("docs.usepayai.xyz")).toBe("https://usepayai.xyz/");
    expect(landingHref("usepayai.xyz")).toBe("/");
    expect(landingHref("localhost")).toBe("/");
  });
  it("every app-side logo links through it (none points at /dashboard)", () => {
    for (const f of ["components/dashboard/Sidebar.tsx", "components/dashboard/MobileNav.tsx", "app/auth/page.tsx", "app/connect/page.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toMatch(/const landing = useLandingHref\(\);/);
      expect(src, f).toMatch(/<Link href=\{landing\}[^>]*>\s*<Logo /);
    }
    expect(readFileSync("components/rooms/PublicShell.tsx", "utf8")).toMatch(/<LandingLink[^>]*>\s*<Logo /);
  });
});
