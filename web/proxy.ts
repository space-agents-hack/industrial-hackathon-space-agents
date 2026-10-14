import { NextResponse, type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // On a developer's machine the Setup page is open to anyone and needs nothing configured, so
  // it can be read on a fresh clone. Deployed, it shows the state of production
  // and stays behind sign-in like every other page.
  if (!process.env.VERCEL) {
    const { pathname } = request.nextUrl;
    // The setup endpoints check for themselves that the request is local (lib/local-request.ts).
    if (pathname === "/setup" || pathname.startsWith("/api/setup/")) return NextResponse.next();
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
