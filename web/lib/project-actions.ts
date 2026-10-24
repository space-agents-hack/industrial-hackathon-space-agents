"use server";

import { cookies } from "next/headers";

import { visibleOrganizations } from "@/lib/access";
import { ORG_COOKIE, ORG_COOKIE_OPTIONS, fetchAccess } from "@/lib/current-org";
import { PROJECT_COOKIE, PROJECT_COOKIE_OPTIONS } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

// Makes a project the one the person works in, and its organisation the current one, so the header
// and the project's sections agree with the page they opened. Only a project the database lets
// them read is stored. Returns whether it was.
export async function rememberProject(projectId: string): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  const supabase = await createClient();
  const [{ data: project }, access] = await Promise.all([
    supabase.from("projects").select("id, organization_id").eq("id", projectId).maybeSingle(),
    fetchAccess(supabase),
  ]);
  if (!project || !visibleOrganizations(access).some((o) => o.id === project.organization_id)) return false;
  const store = await cookies();
  store.set(ORG_COOKIE, project.organization_id, ORG_COOKIE_OPTIONS);
  store.set(PROJECT_COOKIE, project.id, PROJECT_COOKIE_OPTIONS);
  return true;
}
