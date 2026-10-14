import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { type Access, type OrganizationEntry, hasNoAccess } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import type { Database } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type AdminPage =
  | { ok: true; supabase: SupabaseClient<Database>; access: Access; org: OrganizationEntry }
  | { ok: false; reason: AdminRefusal };

export type AdminRefusal = "no-access" | "failed" | "no-organisation" | "not-admin";

// What an organisation tab needs before it reads anything, and the one place a tab decides it
// has nothing to show. (Not the admin layout: a layout that waits for the request before
// rendering {children} drops every page out of the static shell.) Checking first also keeps a
// tab from asking the database for data it would refuse, and logging that refusal as an error.
export async function adminPage(): Promise<AdminPage> {
  const { access, failed, current, permissions } = await getCurrentOrg();
  if (failed) return { ok: false, reason: "failed" };
  if (hasNoAccess(access)) return { ok: false, reason: "no-access" };
  if (!current) return { ok: false, reason: "no-organisation" };
  if (!permissions.manage) return { ok: false, reason: "not-admin" };
  return { ok: true, supabase: await createClient(), access, org: current };
}

// The people of an organisation by user id, for showing emails where the database stores ids.
export async function peopleById(
  supabase: SupabaseClient<Database>,
  org: string,
): Promise<Map<string, string>> {
  const { data, error } = await supabase.rpc("organization_people", { org });
  if (error) {
    console.error("organization_people failed", error);
    return new Map();
  }
  return new Map(data.map((person) => [person.user_id, person.email]));
}
