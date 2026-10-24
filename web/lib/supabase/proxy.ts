import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";
import { PROJECT_COOKIE, needsProject } from "@/lib/navigation";
import { supabaseEnv } from "@/lib/supabase/env";

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const { url, publishableKey } = supabaseEnv();

  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        // A refreshed token has to reach both sides: the request, so the page rendered next reads
        // the new session, and the response, so the browser stores it.
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // Nothing may run between creating the client and this call: it is what refreshes an expired
  // session, and a refresh that happens after the response is built is lost.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);
  const { pathname } = request.nextUrl;

  // Open to a signed-out visitor: signing in, creating an account, and the link in the
  // confirmation email (SYS-35).
  const open = pathname === "/login" || pathname === "/signup" || pathname === "/auth/confirm";
  if (signedIn && (pathname === "/login" || pathname === "/signup")) {
    return withSessionCookies(NextResponse.redirect(new URL("/", request.url)), response);
  }
  // A project's sections without a project picked go to the picker (SYS-36). Only whether the
  // cookie is there is known here; the page checks that the project is still theirs.
  if (signedIn && needsProject(pathname) && !request.cookies.get(PROJECT_COOKIE)) {
    return withSessionCookies(NextResponse.redirect(new URL("/projects", request.url)), response);
  }
  if (signedIn || open) return response;

  if (pathname.startsWith("/api/")) {
    // A redirect would hand a fetch() caller the login page's HTML with a 200.
    return withSessionCookies(
      NextResponse.json({ error: "Not signed in." }, { status: 401 }),
      response,
    );
  }
  // On a developer's machine a signed-out visitor lands on the Setup page, which says what to run
  // and links to sign-in. Deployed, there is nothing to set up, so it is the login page.
  const landing = process.env.VERCEL ? "/login" : "/setup";
  return withSessionCookies(NextResponse.redirect(new URL(landing, request.url)), response);
}

// A response built here replaces the one the Supabase client wrote to, so the cookies it set
// (a refreshed session, or the removal of a dead one) have to be carried over.
function withSessionCookies(target: NextResponse, source: NextResponse): NextResponse {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = source.headers.get(header);
    if (value) target.headers.set(header, value);
  }
  return target;
}
