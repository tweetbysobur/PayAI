import { describe, it, expect } from "vitest";
import {
  canonicalDocsPath,
  isAppPath,
  isDocsHost,
  isDocsSlugPath,
  publicDocsPath,
} from "@/lib/docs/host";
import { docsNavIsActive } from "@/lib/docs/nav";

describe("docs host", () => {
  it("only treats the real docs subdomain as the docs host", () => {
    expect(isDocsHost("docs.usepayai.xyz")).toBe(true);
    expect(isDocsHost("docs.localhost:3000")).toBe(true);
    expect(isDocsHost("usepayai.xyz")).toBe(false);
    expect(isDocsHost("www.usepayai.xyz")).toBe(false);
    expect(isDocsHost("docs.evil.com")).toBe(false);
  });

  it("shortens /docs paths on the docs host", () => {
    expect(publicDocsPath("/docs", true)).toBe("/");
    expect(publicDocsPath("/docs/payments", true)).toBe("/payments");
    expect(publicDocsPath("/security", true)).toBe("/security");
    expect(publicDocsPath("/docs/payments", false)).toBe("/docs/payments");
  });

  it("maps URL-bar paths back to canonical nav hrefs", () => {
    expect(canonicalDocsPath("/")).toBe("/docs");
    expect(canonicalDocsPath("/getting-started")).toBe("/docs/getting-started");
    expect(canonicalDocsPath("/docs/payments")).toBe("/docs/payments");
    expect(canonicalDocsPath("/security")).toBe("/security");
  });

  it("marks Overview active on / and on /docs", () => {
    expect(docsNavIsActive("/docs", "/", true)).toBe(true);
    expect(docsNavIsActive("/docs", "/docs", true)).toBe(true);
    expect(docsNavIsActive("/docs", "/docs/payments", true)).toBe(false);
    expect(docsNavIsActive("/docs/payments", "/payments", false)).toBe(true);
  });

  it("sends product routes off the docs host", () => {
    expect(isAppPath("/dashboard")).toBe(true);
    expect(isAppPath("/auth")).toBe(true);
    expect(isAppPath("/docs")).toBe(false);
    expect(isDocsSlugPath("/getting-started")).toBe(true);
    expect(isDocsSlugPath("/security")).toBe(false);
  });
});
