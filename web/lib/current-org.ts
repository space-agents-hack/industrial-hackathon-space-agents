import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";

import {
  type Access,
  type OrganizationEntry,
  type Permissions,
  NO_ACCESS,
  parseAccess,
  permissionsIn,
  pickCurrentOrganization,
} from "@/lib/access";
import type { Database } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

// The cookie holds an organisation id the person chose in the header. It is a preference, not a
// permission: every read and write is still checked by the database for that organisation.
export const ORG_COOKIE = "org";
// A year: it is a preference, and losing it only means landing on the first organisation.
export const ORG_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 365,
} as const;

export type CurrentOrg = {
  access: Access;
  // my_access() itself failed: the page says so instead of "you have no access".
  failed: boolean;
  current: OrganizationEntry | null;
  permissions: Permissions;
};

// `my_access()` once per request: the header, the layout's gate and the page all ask, and
// React's cache() makes them share one round trip.
export const getAccess = cache(async (): Promise<{ access: Access; failed: boolean }> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_access");
  if (error) {
    console.error("my_access failed", error);
    return { access: NO_ACCESS, failed: true };
  }
  return { access: parseAccess(data), failed: false };
});

export const getCurrentOrg = cache(async (): Promise<CurrentOrg> => {
  const [{ access, failed }, cookieStore] = await Promise.all([getAccess(), cookies()]);
  const current = pickCurrentOrganization(access, cookieStore.get(ORG_COOKIE)?.value);
  return { access, failed, current, permissions: permissionsIn(access, current?.id) };
});

// For route handlers: asks the database, as the caller, what they may do. The answer comes from
// `my_access()`, which reads memberships and platform admins itself; the cookie and anything the
// browser sent play no part. On an error the answer is "nothing".
export async function fetchAccess(supabase: SupabaseClient<Database>): Promise<Access> {
  const { data, error } = await supabase.rpc("my_access");
  if (error) {
    console.error("my_access failed", error);
    return NO_ACCESS;
  }
  return parseAccess(data);
}

export async function managesOrganization(supabase: SupabaseClient<Database>, org: string): Promise<boolean> {
  return permissionsIn(await fetchAccess(supabase), org).manage;
}

export async function isPlatformAdmin(supabase: SupabaseClient<Database>): Promise<boolean> {
  return (await fetchAccess(supabase)).platformAdmin;
}

// Starting, retrying and deciding are for active admins and members of the run's organisation.
export async function actsInRunOrganization(
  supabase: SupabaseClient<Database>,
  runId: string,
): Promise<"yes" | "no" | "missing"> {
  const { data: run, error } = await supabase.from("runs").select("organization_id").eq("id", runId).maybeSingle();
  if (error) console.error(`could not read run ${runId}`, error);
  if (!run) return "missing";
  return permissionsIn(await fetchAccess(supabase), run.organization_id).startRuns ? "yes" : "no";
}
