import { type NextRequest, NextResponse } from "next/server";

import { ORG_COOKIE, ORG_COOKIE_OPTIONS } from "@/lib/current-org";
import {
  OPENROUTER_CALLBACK_PATH,
  OPENROUTER_KEYS_URL,
  OPENROUTER_PKCE_COOKIE,
  type OpenRouterResult,
  requestOrigin,
} from "@/lib/openrouter-oauth";
import { decodePending, sameState } from "@/lib/pkce";
import { createClient, getSessionUser } from "@/lib/supabase/server";

// OpenRouter sends the admin back here with ?code=…&state=…. The code is exchanged for a key
// server to server, the key goes straight into Vault through set_provider_key (which checks,
// as this user, that they manage the organisation), and the browser is sent on with a result
// code only. The key is never in a response, a URL or a log line.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = requestOrigin(request.headers, request.nextUrl);
  const pending = decodePending(request.cookies.get(OPENROUTER_PKCE_COOKIE)?.value);

  const finish = (result: OpenRouterResult) => {
    const response = NextResponse.redirect(new URL(`/admin/providers?openrouter=${result}`, origin));
    // One attempt per cookie, whatever the outcome: a replayed callback finds nothing to use.
    response.cookies.set(OPENROUTER_PKCE_COOKIE, "", { path: OPENROUTER_CALLBACK_PATH, maxAge: 0 });
    // Land on the organisation that was connected, not whichever one another tab switched to.
    if (pending && result === "connected") {
      response.cookies.set(ORG_COOKIE, pending.org, ORG_COOKIE_OPTIONS);
    }
    return response;
  };

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  // OpenRouter returns neither code nor state when the person denies access.
  if (!code) return finish("denied");
  if (!pending) return finish("expired");
  if (!state || !sameState(state, pending.state)) return finish("state");

  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return NextResponse.redirect(new URL("/login", origin));

  let key: string | null = null;
  try {
    const response = await fetch(OPENROUTER_KEYS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: "S256" }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok && typeof body === "object" && body !== null && typeof (body as { key?: unknown }).key === "string") {
      key = (body as { key: string }).key;
    } else {
      // The status only: OpenRouter's error body is not ours to log in full.
      console.error(`OpenRouter callback: key exchange answered ${response.status}`);
    }
  } catch {
    console.error("OpenRouter callback: key exchange did not answer");
  }
  if (!key) return finish("exchange");

  const { error } = await supabase.rpc("set_provider_key", {
    org: pending.org,
    key_provider: "openrouter",
    api_key: key,
    key_source: "openrouter_oauth",
  });
  if (error) {
    console.error("OpenRouter callback: set_provider_key failed", error.code, error.message);
    return finish(error.code === "42501" ? "forbidden" : "store");
  }
  return finish("connected");
}
