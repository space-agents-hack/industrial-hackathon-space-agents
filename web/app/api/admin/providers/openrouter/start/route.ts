import { type NextRequest, NextResponse } from "next/server";

import { managesOrganization } from "@/lib/current-org";
import {
  OPENROUTER_CALLBACK_PATH,
  OPENROUTER_PKCE_COOKIE,
  OPENROUTER_PKCE_MAX_AGE_S,
  openRouterAuthUrl,
  requestOrigin,
} from "@/lib/openrouter-oauth";
import { challengeS256, encodePending, randomToken } from "@/lib/pkce";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// GET ?org=<id>: the "Connect OpenRouter" button. Sends the admin to OpenRouter with a PKCE
// challenge; OpenRouter sends them back to the callback with a one-time code, which only the
// holder of the verifier (this server, through the cookie set here) can turn into a key.
export async function GET(request: NextRequest) {
  const org = request.nextUrl.searchParams.get("org");
  const origin = requestOrigin(request.headers, request.nextUrl);
  const back = (result: string) => NextResponse.redirect(new URL(`/admin/providers?openrouter=${result}`, origin));

  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return NextResponse.redirect(new URL("/login", origin));
  if (!isUuid(org) || !(await managesOrganization(supabase, org))) return back("forbidden");

  const verifier = randomToken(32);
  const state = randomToken(32);
  const challenge = await challengeS256(verifier);
  const response = NextResponse.redirect(openRouterAuthUrl(origin, challenge, state));
  // httpOnly: page scripts never see the verifier. Lax: the cookie still comes back on the
  // top-level redirect from openrouter.ai, which Strict would drop. Scoped to the callback path,
  // so no other request carries it.
  response.cookies.set(OPENROUTER_PKCE_COOKIE, encodePending({ verifier, state, org }), {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https:"),
    path: OPENROUTER_CALLBACK_PATH,
    maxAge: OPENROUTER_PKCE_MAX_AGE_S,
  });
  return response;
}
