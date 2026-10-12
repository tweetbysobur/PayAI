import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("app links and claims", () => {
  it("the first-run Swap quick action opens the Swap page, not Send", () => {
    expect(read("components/onboarding/FirstRunSteps.tsx")).toMatch(/id: "swap"[^}]*href: "\/dashboard\/swap"/);
  });
  it("Reserved Funds is not badged as guaranteed", () => {
    expect(read("components/dashboard/AutomationCreator.tsx").replace(/\/\/.*$/gm, "")).not.toMatch(/Guaranteed Execution/i);
  });
  it("every /dashboard link in the app points at a page that exists", () => {
    const files = ["components/onboarding/FirstRunSteps.tsx", "components/dashboard/Sidebar.tsx", "app/dashboard/page.tsx", "lib/hooks/notificationItems.ts", "lib/wallet-service/types.ts"];
    for (const f of files) {
      for (const m of read(f).matchAll(/"(\/dashboard[a-z/-]*)/g)) {
        expect(existsSync(join(__dirname, "..", "app", m[1], "page.tsx")), `${f} → ${m[1]}`).toBe(true);
      }
    }
  });
});
