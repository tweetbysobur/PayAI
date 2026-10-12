import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const count = (s: string, needle: string) => s.split(needle).length - 1;

// One run, one "Execution started" notification. The shared pipeline used to
// post one too, on top of the caller's, so every run showed it twice.
describe("an automation run posts 'Execution started' exactly once", () => {
  it("the shared execution pipeline posts none", () => {
    expect(read("lib/automation/execute.ts")).not.toMatch(/execution_started/);
  });
  it("the scheduler posts one per occurrence", () => {
    expect(count(read("app/api/cron/run-schedules/route.ts"), 'type: "execution_started"')).toBe(1);
  });
  it("Execute Now posts one", () => {
    expect(count(read("app/api/automations/route.ts"), 'type: "execution_started"')).toBe(1);
  });
});
