import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

// Where the confirmation email sends a new account (SYS-35). Supabase's link carries either a
// one-time code (PKCE) or a token hash, depending on the email template; both end in a session
// cookie, then the onboarding page.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const supabase = await createClient();
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("no code in the link") };
  if (error) {
    console.error("auth confirm failed", error);
    return NextResponse.redirect(new URL("/login?confirm=failed", request.url), 303);
  }
  return NextResponse.redirect(new URL("/welcome", request.url), 303);
}
