import { NextRequest, NextResponse } from "next/server";
import { hostAction, hostKind } from "@/lib/hosts";

/**
 * Same deployment, three hostnames:
 *   usepayai.xyz        marketing
 *   app.usepayai.xyz    the product
 *   docs.usepayai.xyz   documentation
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg"
  ) {
    return NextResponse.next();
  }

  const action = hostAction(hostKind(req.headers.get("host")), pathname);
  if (action.type === "redirect") {
    return NextResponse.redirect(new URL(action.pathname + search, action.origin));
  }
  if (action.type === "rewrite") {
    const url = req.nextUrl.clone();
    url.pathname = action.pathname;
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
