import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/lib/database.types";
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

  if (signedIn && pathname === "/login") {
    return withSessionCookies(NextResponse.redirect(new URL("/", request.url)), response);
  }
  if (signedIn || pathname === "/login") return response;

  if (pathname.startsWith("/api/")) {
    // A redirect would hand a fetch() caller the login page's HTML with a 200.
    return withSessionCookies(
      NextResponse.json({ error: "Not signed in." }, { status: 401 }),
      response,
    );
  }
  return withSessionCookies(NextResponse.redirect(new URL("/login", request.url)), response);
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
