import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isNavActive } from "@/components/dashboard/primitives";
import { NAV, PAYMENTS_AREA, SETTINGS_AREA, HELP_LINK } from "@/components/dashboard/Sidebar";

/**
 * The dashboard's information architecture: five primary destinations, and
 * every page that used to be a sidebar row still reachable one level down.
 */
const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const pageFor = (href: string) => join(root, "app", ...href.replace(/^\//, "").split("/"), "page.tsx");

describe("primary navigation", () => {
  it("is exactly Dashboard, Ask PayAI, Rooms, Payments & Automations, Settings", () => {
    expect(NAV.map((n) => n.label)).toEqual(["Dashboard", "Ask PayAI", "Rooms", "Payments & Automations", "Settings"]);
  });

  it("has no Plans entry anywhere in the navigation", () => {
    const all = [...NAV, ...PAYMENTS_AREA, ...SETTINGS_AREA, HELP_LINK];
    expect(all.some((n) => /plan/i.test(n.label) || n.href.includes("/plans"))).toBe(false);
  });

  it("every nav, tab and help destination is a real page", () => {
    for (const n of [...NAV, ...PAYMENTS_AREA, ...SETTINGS_AREA, HELP_LINK]) {
      expect(existsSync(pageFor(n.href)), n.href).toBe(true);
    }
  });

  it("every page the old sidebar linked to is still reachable", () => {
    const reachable = new Set([...NAV, ...PAYMENTS_AREA, ...SETTINGS_AREA, HELP_LINK].map((n) => n.href));
    for (const old of ["/dashboard", "/dashboard/ask", "/dashboard/payments", "/dashboard/recipients", "/dashboard/invoices",
      "/dashboard/automations", "/dashboard/transactions", "/dashboard/wallets", "/dashboard/settings", "/dashboard/help"]) {
      expect(reachable.has(old), old).toBe(true);
    }
  });

  it("an area's primary entry is active on every page inside it, and Dashboard only on itself", () => {
    const pa = NAV.find((n) => n.label === "Payments & Automations")!;
    const settings = NAV.find((n) => n.label === "Settings")!;
    const dash = NAV.find((n) => n.label === "Dashboard")!;
    for (const t of PAYMENTS_AREA) expect(isNavActive(t.href, pa), t.href).toBe(true);
    for (const t of SETTINGS_AREA) expect(isNavActive(t.href, settings), t.href).toBe(true);
    expect(isNavActive("/dashboard/transactions", settings)).toBe(false);
    expect(isNavActive("/dashboard", dash)).toBe(true);
    expect(isNavActive("/dashboard/ask", dash)).toBe(false);
    // A prefix of a word is not a match.
    expect(isNavActive("/dashboard/paymentsx", pa)).toBe(false);
  });

  it("the guided tour targets entries the sidebar actually renders", () => {
    const tour = read("components/onboarding/TourOverlay.tsx");
    const targets = [...tour.matchAll(/target: "([a-z]+)"/g)].map((m) => m[1]);
    const sidebar = read("components/dashboard/Sidebar.tsx");
    for (const t of targets) expect(sidebar, t).toMatch(new RegExp(`: "${t}"`));
  });
});

describe("Rooms is honest about what it is (built: docs/hackathon/payai-rooms-cleanverse.md §16)", () => {
  const list = read("app/dashboard/rooms/page.tsx");
  const room = read("app/dashboard/rooms/[id]/page.tsx");
  it("says rooms are open (unverified), have no escrow and refund nothing — before creating and on every room", () => {
    for (const src of [list, room]) {
      expect(src).toMatch(/identity-verified/);
      expect(src).toMatch(/no escrow/);
      expect(src).toMatch(/never holds/);
    }
  });
  it("shows no sample rooms, participants or balances", () => {
    for (const src of [list, room]) expect(src).not.toMatch(/sample|mock|demo|placeholder data/i);
  });
  it("pays a share only through the existing plan card — the pages themselves never sign", () => {
    expect(room).toMatch(/<PlanCard /);
    for (const src of [list, room]) expect(src).not.toMatch(/sendTransaction|waitForReceipt|createPlanRunner/);
  });
});

describe("dashboard surfaces add no execution path", () => {
  it("the dashboard pages added or redesigned here call no signing or broadcast API", () => {
    for (const f of ["app/dashboard/page.tsx", "app/dashboard/swap/page.tsx", "app/dashboard/rooms/page.tsx", "app/dashboard/rooms/[id]/page.tsx", "app/dashboard/settings/page.tsx",
      "components/dashboard/primitives.tsx", "components/dashboard/Sidebar.tsx", "components/dashboard/MobileNav.tsx", "components/dashboard/AskEntry.tsx",
      "components/onboarding/OnboardingFlow.tsx", "lib/ask/handoff.ts", "lib/ask/AskPageChatContext.tsx"]) {
      expect(read(f), f).not.toMatch(/sendTransaction|waitForReceipt|eth_sendTransaction|personal_sign|signTypedData/);
    }
  });
});
