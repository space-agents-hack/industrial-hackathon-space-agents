import "server-only";

import { createClient } from "@supabase/supabase-js";

import { supabaseEnv } from "@/lib/supabase/env";

// Changing the deployment asks for the password again: a session left open on a shared laptop
// should not be enough to replace the database password or the Vercel token. The check is a
// sign-in on a throwaway client, signed out again at once so it leaves no session behind; the
// person's own session is not touched.
export async function passwordMatches(email: string, password: string): Promise<boolean> {
  const { url, publishableKey } = supabaseEnv();
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  await client.auth.signOut({ scope: "local" });
  return true;
}
