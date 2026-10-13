import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { connection } from "next/server";

import type { Database } from "@/lib/database.types";
import { supabaseEnv } from "@/lib/supabase/env";

// One client per request, acting as the signed-in user: the publishable key plus the session
// cookie. There is no secret-key client anywhere in this app, so RLS decides every read and write.
export async function createClient(): Promise<SupabaseClient<Database>> {
  // Wait for a real request. With Partial Prefetching a route that reads cookies is prerendered
  // once per session as a reusable shell; without this line that prerender ran the Supabase
  // client (which checks token expiry with Date.now()) and Next.js reported an error. Runs and
  // approvals must also never come from a prefetched shell.
  await connection();
  const cookieStore = await cookies();
  const { url, publishableKey } = supabaseEnv();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. proxy.ts has already refreshed the session
          // for this request, so there is nothing to persist here.
        }
      },
    },
  });
}

export type SessionUser = { id: string; email: string | null };

// getClaims() verifies the token's signature; getSession() would trust whatever the cookie says.
export async function getSessionUser(
  supabase: SupabaseClient<Database>,
): Promise<SessionUser | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  const { sub, email } = data.claims;
  return { id: sub, email: typeof email === "string" ? email : null };
}
