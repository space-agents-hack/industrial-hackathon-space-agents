import { NextResponse, type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // On a developer's machine the Setup page is open to anyone and needs nothing configured, so
  // it can be read on a fresh clone. Deployed, it shows the state of production
  // and stays behind sign-in like every other page.
  if (!process.env.VERCEL) {
    const { pathname } = request.nextUrl;
    // The setup endpoints check for themselves that the request is local (lib/local-request.ts).
    // The page shows this machine's git email and the repository's secret names, so it too answers
    // only to a loopback Host under `make dev`: a site that rebinds its own name to 127.0.0.1
    // could otherwise read it from another tab.
    if (pathname === "/setup" || pathname.startsWith("/api/setup/")) {
      const host = request.headers.get("host") ?? "";
      if (process.env.SETUP_LOOPBACK_ONLY === "1" && !/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) {
        return new NextResponse(null, { status: 403 });
      }
      // Its buttons create apps and start releases: no other site may frame it and steer a click.
      const response = NextResponse.next();
      response.headers.set("x-frame-options", "DENY");
      response.headers.set("content-security-policy", "frame-ancestors 'none'");
      return response;
    }
    const configured =
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    // Nothing else can work without a database; send the person to the steps instead of an error.
    if (!configured) return NextResponse.redirect(new URL("/setup", request.url));
  }
  return updateSession(request);
}

export const config = {
  // Everything except Next.js build output, files with a static extension and the health check.
  // /api/health and /api/health/deep are left out here, not just allowed inside updateSession, so the deploy smoke test
  // still answers when the Supabase variables are missing or Auth is down.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health(?:/deep)?$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)",
  ],
};
