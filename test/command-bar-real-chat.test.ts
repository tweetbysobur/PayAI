import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The floating command-bar popup used to run its own separate single-shot
 * "type a command, see one result, New command to reset" console
 * (useAgentConsole) — a different, older implementation from the real
 * multi-turn Ask PayAI chat on /dashboard/ask. That meant the popup and the
 * page behaved differently for the same feature. The popup now renders from
 * the exact same conversation engine (useAskChat) and the exact same chat
 * components as the full page, so "ask a question in the popup" and "ask it
 * on the page" are provably the same pipeline, not two that can drift apart.
 */

const src = readFileSync(new URL("../components/dashboard/CommandBar.tsx", import.meta.url), "utf8");

describe("the popup renders the real Ask PayAI chat, not its own console", () => {
  it("uses the shared conversation engine", () => {
    expect(src).toMatch(/import\s*\{\s*useAskChat,\s*retryTextFor\s*\}\s*from\s*"@\/lib\/ask\/useAskChat"/);
    expect(src).toMatch(/const chat = useAskChat\(\)/);
  });

  it("renders the same chat components the full page uses", () => {
    expect(src).toMatch(/import\s*\{\s*ChatMessageRow,\s*ThinkingRow\s*\}\s*from\s*"@\/components\/ask\/ChatMessage"/);
    expect(src).toMatch(/import\s*\{\s*ChatComposer\s*\}\s*from\s*"@\/components\/ask\/ChatComposer"/);
    expect(src).toMatch(/import\s*\{\s*AskEmptyState\s*\}\s*from\s*"@\/components\/ask\/AskEmptyState"/);
    expect(src).toMatch(/<ChatMessageRow/);
    expect(src).toMatch(/<ChatComposer/);
    expect(src).toMatch(/<AskEmptyState onPick=\{chat\.send\}/);
  });

  it("no longer runs the old single-shot console pipeline", () => {
    expect(src).not.toMatch(/useAgentConsole/);
    expect(src).not.toMatch(/PipelineStepper/);
    expect(src).not.toMatch(/ConfirmDetails/);
  });
});

describe("the conversation survives closing and reopening the popup", () => {
  it("calls useAskChat at the component's top level, not inside the open-only JSX", () => {
    // Anything declared after the modal's conditional render only exists
    // while it's open; useAskChat must run above that so its state isn't
    // torn down when the popup closes.
    const hookCall = src.indexOf("const chat = useAskChat()");
    const conditionalOpen = src.indexOf("{open && (");
    expect(hookCall).toBeGreaterThan(-1);
    expect(conditionalOpen).toBeGreaterThan(-1);
    expect(hookCall).toBeLessThan(conditionalOpen);
  });
});
