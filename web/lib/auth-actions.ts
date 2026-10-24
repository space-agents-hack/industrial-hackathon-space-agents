"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { PROJECT_COOKIE } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/server";

// `email` is echoed back because React clears an uncontrolled form after its action runs.
export type SignInState = { error: string; email: string } | null;

// Sign-in and sign-out run on the server so the session cookie is written by the response
// itself. Writing a cookie in a Server Action also clears the browser's cache of rendered
// pages, so nothing rendered for one user is shown to the next.
export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (email === "" || password === "") return { error: "Enter your email and your password.", email };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "invalid_credentials") {
      return { error: "The email or the password is wrong.", email };
    }
    console.error("signIn failed", error);
    return { error: "Sign-in failed. Check that the authentication service is reachable.", email };
  }
  // Every sign-in starts by picking a project (Clemente, 2026-10-24): the last one is forgotten.
  (await cookies()).delete(PROJECT_COOKIE);
  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  // "local" ends this browser's session only. The default ("global") would also sign out a
  // teammate using the same account on another laptop in the middle of a demo.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}

export type SignUpState = { error: string; email: string } | { sent: string } | null;

// Self sign-up (SYS-35). An account grants nothing on its own: without an approved request it
// belongs to no organisation and RLS returns nothing. Whether sign-up is allowed at all is the
// hosted project's setting (supabase/README.md), so a refusal from it is said plainly.
export async function signUp(_previous: SignUpState, formData: FormData): Promise<SignUpState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (email === "" || password === "") return { error: "Enter your email and a password.", email };
  if (password.length < 8) return { error: "Use a password of at least 8 characters.", email };

  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // Only used when the project asks new accounts to confirm their email.
    options: host ? { emailRedirectTo: `${protocol}://${host}/auth/confirm` } : undefined,
  });
  if (error) {
    if (error.code === "signup_disabled" || error.code === "email_provider_disabled") {
      return { error: "New accounts are turned off on this deployment. Ask an administrator to create yours.", email };
    }
    if (error.code === "user_already_exists" || error.code === "email_exists") {
      return { error: "There is already an account with this email. Sign in instead.", email };
    }
    if (error.code === "weak_password" || error.code === "email_address_invalid") {
      return { error: error.message, email };
    }
    if (error.code === "over_email_send_rate_limit") {
      return { error: "Too many sign-ups in the last hour for the confirmation emails. Try again later.", email };
    }
    console.error("signUp failed", error);
    return { error: "Sign-up failed. Check that the authentication service is reachable.", email };
  }
  // With email confirmation on there is no session yet; the link in the email signs them in.
  if (!data.session) return { sent: email };
  (await cookies()).delete(PROJECT_COOKIE);
  redirect("/welcome");
}
