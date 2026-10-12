import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inAppBrowserName, suggestedBrowser } from "@/lib/wallet-service/passkeyEnvironment";

/** Passkey wallet set-up on phones: in-app browser detection, and the sign-in
 *  page's handling of a blocked creation prompt. */

const UA = {
  iosSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  iosWhatsApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/24.12.78",
  iosInstagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.40.92",
  androidFacebook: "Mozilla/5.0 (Linux; Android 13; SM-A515F Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]",
  androidWebView: "Mozilla/5.0 (Linux; Android 14; SM-S918B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36",
  telegram: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 Telegram-Android/11.2.0",
};

describe("in-app browsers", () => {
  it("names the app whose built-in browser is open", () => {
    expect(inAppBrowserName(UA.iosWhatsApp)).toBe("WhatsApp");
    expect(inAppBrowserName(UA.iosInstagram)).toBe("Instagram");
    expect(inAppBrowserName(UA.androidFacebook)).toBe("Facebook");
    expect(inAppBrowserName(UA.telegram)).toBe("Telegram");
    expect(inAppBrowserName(UA.androidWebView)).toBe("this app");
  });
  it("leaves real browsers alone", () => {
    expect(inAppBrowserName(UA.iosSafari)).toBeNull();
    expect(inAppBrowserName(UA.androidChrome)).toBeNull();
  });
  it("suggests Safari on Apple devices and Chrome elsewhere", () => {
    expect(suggestedBrowser(UA.iosWhatsApp)).toBe("Safari");
    expect(suggestedBrowser(UA.androidFacebook)).toBe("Chrome");
  });
});

describe("sign-in page", () => {
  const page = readFileSync("app/auth/page.tsx", "utf8");
  it("warms the status check on load and after a failed attempt", () => {
    expect(page).toMatch(/useEffect\(\(\) => \{[\s\S]*?warmStatus\(\);\s*\}, \[\]\);/);
    expect((page.match(/warmStatus\(\);/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("a blocked or cancelled create stays on the create screen with a retry message", () => {
    expect(page).toMatch(/if \(opts\?\.create && code === "cancelled"\) \{[\s\S]*?setStep\("choice"\);/);
    expect(page).toMatch(/your browser may have blocked it/);
  });
  it("shows the in-app / unsupported notice before the user taps", () => {
    expect((page.match(/<PasskeyEnvNotice env=\{env\} \/>/g) ?? []).length).toBe(2);
  });
});

describe("wallet set-up doesn't wait on the network between the tap and the passkey prompt", () => {
  const ctx = readFileSync("lib/wallet-service/WalletServiceContext.tsx", "utf8");
  const setUp = ctx.slice(ctx.indexOf("const setUpEmbeddedWallet"), ctx.indexOf("const { handle, created } = await provider.open"));

  it("uses the status already read when the page opened instead of fetching again", () => {
    expect(setUp).toMatch(/await \(statusRef\.current \?\? loadStatus\(\)\)/);
    expect(setUp).not.toMatch(/fetch\("\/api\/wallet-service\/status"\)/);
  });
  it("the page-open read fills the held status", () => {
    expect(ctx).toMatch(/useEffect\(\(\) => \{\s*void loadStatus\(\);\s*\}, \[loadStatus\]\);/);
  });
  it("anything that changes the sign-in drops the held status, so the existing-wallet check never uses stale data", () => {
    // email sign-in, unlinking Google, signing out, and linking a wallet
    expect((ctx.match(/invalidateStatus\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(ctx).toMatch(/authMethod: "email", label: email \}\);\s*\/\/[^\n]*\n\s*invalidateStatus\(\);\s*void loadStatus\(\);/);
    expect(ctx).toMatch(/signOutEmbedded[\s\S]*?setAccountWallet\(null\);\s*invalidateStatus\(\);/);
  });
  it("a failed status read is never reused", () => {
    expect(ctx).toMatch(/if \(statusRef\.current === p\) statusRef\.current = null;/);
  });
  it("the existing-wallet decision still comes from the server's linked address", () => {
    expect(setUp).toMatch(/serverHasWallet = !!status\.serverAddress;\s*serverAddress = status\.serverAddress;/);
    expect(ctx).toMatch(/!openedWalletMatchesAccount\(serverAddress, handle\.address\)/);
  });
});
