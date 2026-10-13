"use server";

import { redirect } from "next/navigation";

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
  redirect("/");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  // "local" ends this browser's session only. The default ("global") would also sign out a
  // teammate using the same account on another laptop in the middle of a demo.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
