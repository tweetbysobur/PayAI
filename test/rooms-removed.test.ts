import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NAV, PAYMENTS_AREA, SETTINGS_AREA } from "@/components/dashboard/Sidebar";
import { GUIDE, PRODUCT_EXAMPLES } from "@/components/landing/intentExamples";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

/** Rooms were removed from PayAI. Nothing user-facing may offer them. */
describe("Rooms are removed", () => {
  it("are not in the navigation or the tour", () => {
    for (const n of [...NAV, ...PAYMENTS_AREA, ...SETTINGS_AREA]) expect(n.href).not.toMatch(/rooms/);
    expect(read("components/onboarding/TourOverlay.tsx")).not.toMatch(/target: "rooms"/);
  });

  it("old room links redirect instead of rendering a room", () => {
    for (const f of ["app/dashboard/rooms/page.tsx", "app/dashboard/rooms/[id]/page.tsx", "app/rooms/page.tsx", "app/r/[id]/page.tsx"]) {
      expect(read(f), f).toMatch(/redirect\(|permanentRedirect\(/);
    }
    for (const f of ["components/ask/RoomAskCard.tsx", "components/ask/EscrowRoomAskCard.tsx", "components/rooms"]) {
      expect(existsSync(join(__dirname, "..", f)), f).toBe(false);
    }
  });

  it("the Rooms API answers 410 Gone to everything", async () => {
    for (const mod of [await import("@/app/api/rooms/route"), await import("@/app/api/rooms/[id]/route")]) {
      for (const h of [mod.GET, mod.POST]) {
        const r = await h();
        expect(r.status).toBe(410);
        expect(await r.json()).toMatchObject({ ok: false, code: "ROOMS_REMOVED" });
      }
    }
    const live = await (await import("@/app/api/rooms/live/route")).GET();
    expect(live.status).toBe(410);
  });

  it("the site offers no room prompts or Room copy", () => {
    const prompts = [...GUIDE.flatMap((g) => g.examples), ...PRODUCT_EXAMPLES].map((e) => e.say);
    for (const p of prompts) expect(p).not.toMatch(/\broom\b/i);
    for (const f of ["app/page.tsx", "app/product/page.tsx", "app/security/page.tsx", "components/landing/ProductSections.tsx", "components/landing/HowToAskSection.tsx"]) {
      expect(read(f), f).not.toMatch(/\bRooms?\b/);
    }
  });

  it("the chat no longer renders a room card", () => {
    expect(read("components/ask/ChatMessage.tsx")).not.toMatch(/RoomAskCard|message\.room/);
  });
});
