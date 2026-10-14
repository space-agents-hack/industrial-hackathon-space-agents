"use server";

import { cookies } from "next/headers";

import { visibleOrganizations } from "@/lib/access";
import { ORG_COOKIE, ORG_COOKIE_OPTIONS, fetchAccess } from "@/lib/current-org";
import { createClient } from "@/lib/supabase/server";

// The header's organisation switcher. Only an organisation the person may see is stored; any
// other id is ignored, and the database would refuse its data anyway. Setting a cookie in a
// Server Action makes Next.js re-render the current page with it in the same round trip.
export async function switchOrganization(organizationId: string): Promise<void> {
  const access = await fetchAccess(await createClient());
  if (!visibleOrganizations(access).some((o) => o.id === organizationId)) return;
  (await cookies()).set(ORG_COOKIE, organizationId, ORG_COOKIE_OPTIONS);
}
