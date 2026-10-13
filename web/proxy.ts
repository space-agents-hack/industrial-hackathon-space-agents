import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Everything except Next.js build output, files with a static extension and the health check.
  // /api/health is left out here, not just allowed inside updateSession, so the deploy smoke test
  // still answers when the Supabase variables are missing or Auth is down.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)",
  ],
};
