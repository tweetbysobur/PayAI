import { NextRequest, NextResponse } from "next/server";
import { APP_ORIGIN, isAppPath, isDocsHost, isDocsSlugPath } from "@/lib/docs/host";

/**
 * Same deployment serves usepayai.xyz and docs.usepayai.xyz.
 * Adding the subdomain in Vercel is free — no second project, no second domain.
 */
export function middleware(req: NextRequest) {
  if (!isDocsHost(req.headers.get("host"))) return NextResponse.next();

  const { pathname, search } = req.nextUrl;

  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg"
  ) {
    return NextResponse.next();
  }

  if (isAppPath(pathname)) {
    return NextResponse.redirect(new URL(pathname + search, APP_ORIGIN));
  }

  if (pathname === "/docs" || pathname === "/docs/") {
    return NextResponse.redirect(new URL("/" + search, req.url));
  }
  if (pathname.startsWith("/docs/")) {
    return NextResponse.redirect(new URL(pathname.slice("/docs".length) + search, req.url));
  }

  if (pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/docs";
    return NextResponse.rewrite(url);
  }

  if (isDocsSlugPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = `/docs${pathname}`;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
