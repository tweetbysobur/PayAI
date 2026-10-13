import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// Every place the app confirms a transaction tells the dashboard right away,
// so the pop-up and the bell don't wait for the next 20 s refresh.
describe("transactions refresh the dashboard as they confirm", () => {
  it("the sync provider listens for the transaction event", () => {
    const src = read("lib/hooks/useSync.tsx");
    expect(src).toMatch(/export function announceTransaction/);
    expect(src).toMatch(/addEventListener\(TX_EVENT, onTransaction\)/);
    expect(src).toMatch(/removeEventListener\(TX_EVENT, onTransaction\)/);
  });

  it.each([
    "components/ask/PlanCard.tsx",
    "components/dashboard/BulkPaymentCreator.tsx",
    "components/dashboard/automationShared.tsx",
    "components/dashboard/ReservationRecovery.tsx",
    "components/dashboard/TopUpModal.tsx",
  ])("%s announces confirmed transactions", (file) => {
    expect(read(file)).toMatch(/announceTransaction\(\)/);
  });
});
