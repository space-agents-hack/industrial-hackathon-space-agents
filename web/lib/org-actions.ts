"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { visibleOrganizations } from "@/lib/access";
import { ORG_COOKIE, ORG_COOKIE_OPTIONS, fetchAccess } from "@/lib/current-org";
import { PROJECT_COOKIE } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/server";

// The header's organisation switcher. Only an organisation the person may see is stored; any
// other id is ignored, and the database would refuse its data anyway. A project belongs to one
// organisation, so switching drops it and lands on the new organisation's projects (SYS-36).
export async function switchOrganization(organizationId: string): Promise<void> {
  const access = await fetchAccess(await createClient());
  if (!visibleOrganizations(access).some((o) => o.id === organizationId)) return;
  const store = await cookies();
  store.set(ORG_COOKIE, organizationId, ORG_COOKIE_OPTIONS);
  store.delete(PROJECT_COOKIE);
  redirect("/projects");
}
