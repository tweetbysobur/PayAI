import { describe, it, expect } from "vitest";
import {
  cookieDomain,
  hostAction,
  hostKind,
  passkeyRpId,
  APP_ORIGIN,
  DOCS_ORIGIN,
  MARKETING_ORIGIN,
} from "@/lib/hosts";

describe("hostKind", () => {
  it("maps the three production hosts", () => {
    expect(hostKind("usepayai.xyz")).toBe("marketing");
    expect(hostKind("app.usepayai.xyz")).toBe("app");
    expect(hostKind("docs.usepayai.xyz")).toBe("docs");
  });

  it("leaves preview and localhost unsplit", () => {
    expect(hostKind("localhost:3000")).toBe("unsplit");
    expect(hostKind("payai-git-main.vercel.app")).toBe("unsplit");
    expect(hostKind("docs.evil.com")).toBe("unsplit");
  });

  it("treats the old Vercel alias as legacy, not a public app host", () => {
    expect(hostKind("veripayai.vercel.app")).toBe("legacy");
    expect(hostKind("www.usepayai.xyz")).toBe("legacy");
  });
});

describe("hostAction", () => {
  it("sends app routes off the marketing site", () => {
    expect(hostAction("marketing", "/auth")).toEqual({
      type: "redirect",
      origin: APP_ORIGIN,
      pathname: "/auth",
    });
    expect(hostAction("marketing", "/dashboard/payments")).toEqual({
      type: "redirect",
      origin: APP_ORIGIN,
      pathname: "/dashboard/payments",
    });
  });

  it("sends /docs off the marketing site to the docs host", () => {
    expect(hostAction("marketing", "/docs")).toEqual({
      type: "redirect",
      origin: DOCS_ORIGIN,
      pathname: "/",
    });
    expect(hostAction("marketing", "/docs/contracts")).toEqual({
      type: "redirect",
      origin: DOCS_ORIGIN,
      pathname: "/contracts",
    });
  });

  it("serves docs at the root of the docs host", () => {
    expect(hostAction("docs", "/")).toEqual({ type: "rewrite", pathname: "/docs" });
    expect(hostAction("docs", "/contracts")).toEqual({ type: "rewrite", pathname: "/docs/contracts" });
    expect(hostAction("docs", "/sdk")).toEqual({ type: "rewrite", pathname: "/docs/sdk" });
    expect(hostAction("docs", "/auth")).toEqual({
      type: "redirect",
      origin: APP_ORIGIN,
      pathname: "/auth",
    });
    expect(hostAction("docs", "/product")).toEqual({
      type: "redirect",
      origin: MARKETING_ORIGIN,
      pathname: "/product",
    });
  });

  it("opens the app host on the dashboard", () => {
    expect(hostAction("app", "/")).toEqual({
      type: "redirect",
      origin: APP_ORIGIN,
      pathname: "/dashboard",
    });
    expect(hostAction("app", "/auth")).toEqual({ type: "next" });
    expect(hostAction("app", "/product")).toEqual({
      type: "redirect",
      origin: MARKETING_ORIGIN,
      pathname: "/product",
    });
  });

  it("does not split preview hosts", () => {
    expect(hostAction("unsplit", "/auth")).toEqual({ type: "next" });
    expect(hostAction("unsplit", "/docs")).toEqual({ type: "next" });
  });

  it("sends the old Vercel alias to the canonical hosts", () => {
    expect(hostAction("legacy", "/")).toEqual({
      type: "redirect",
      origin: MARKETING_ORIGIN,
      pathname: "/",
    });
    expect(hostAction("legacy", "/dashboard")).toEqual({
      type: "redirect",
      origin: APP_ORIGIN,
      pathname: "/dashboard",
    });
    expect(hostAction("legacy", "/docs/contracts")).toEqual({
      type: "redirect",
      origin: DOCS_ORIGIN,
      pathname: "/contracts",
    });
  });
});

describe("passkeys and cookies survive the subdomain split", () => {
  it("uses the registrable domain as rpId", () => {
    expect(passkeyRpId("usepayai.xyz")).toBe("usepayai.xyz");
    expect(passkeyRpId("app.usepayai.xyz")).toBe("usepayai.xyz");
    expect(passkeyRpId("localhost")).toBe("localhost");
  });

  it("scopes cookies to .usepayai.xyz only on that family", () => {
    expect(cookieDomain("app.usepayai.xyz")).toBe(".usepayai.xyz");
    expect(cookieDomain("localhost")).toBeUndefined();
    expect(cookieDomain("foo.vercel.app")).toBeUndefined();
  });
});
