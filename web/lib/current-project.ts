import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { getCurrentOrg } from "@/lib/current-org";
import { PROJECT_COOKIE } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

export type CurrentProject = { id: string; name: string; organization_id: string };

// The project the person is working in (SYS-36). The cookie only says which one they picked; it
// counts only if the project still exists, the database lets them read it, and it belongs to the
// current organisation. Otherwise there is none, and the project's sections are not offered.
export const getCurrentProject = cache(async (): Promise<CurrentProject | null> => {
  const [{ current }, cookieStore] = await Promise.all([getCurrentOrg(), cookies()]);
  const id = cookieStore.get(PROJECT_COOKIE)?.value;
  if (!current || !id || !isUuid(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, organization_id")
    .eq("id", id)
    .eq("organization_id", current.id)
    .maybeSingle();
  if (error) console.error("current project: read failed", error);
  return data ?? null;
});
