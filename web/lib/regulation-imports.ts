import "server-only";

import { fail, requireManager } from "@/lib/admin-route";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// For the routes that act on one import (resume, cancel): the caller must manage the
// organisation whose library the import fills. The organisation is read from the import as the
// caller, so an import they cannot see is "unknown", not "forbidden".
export async function requireImportManager(id: string): ReturnType<typeof requireManager> {
  if (!isUuid(id)) return fail("Unknown import.", 404);
  const supabase = await createClient();
  if (!(await getSessionUser(supabase))) return fail("Not signed in.", 401);
  const { data, error } = await supabase
    .from("regulation_imports")
    .select("organization_id")
    .eq("id", id)
    .maybeSingle();
  if (error) console.error(`could not read regulation import ${id}`, error);
  if (!data) return fail("Unknown import.", 404);
  return requireManager(data.organization_id);
}
