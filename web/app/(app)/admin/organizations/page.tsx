import type { Metadata } from "next";
import { Suspense } from "react";

import { type OrganizationSummary, OrganizationsPanel } from "@/components/admin/organizations-panel";
import { NoAccess } from "@/components/no-access";
import { getCurrentOrg } from "@/lib/current-org";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Organisations" };

export default function OrganizationsPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading organisations…</p>}>
      <Organizations />
    </Suspense>
  );
}

async function Organizations() {
  const { access, failed, current } = await getCurrentOrg();
  if (failed) return <NoAccess failed />;
  if (!access.platformAdmin) {
    return <p className="text-muted-foreground">Only a platform admin sees every organisation.</p>;
  }

  // RLS lets a platform admin read every organisation and membership.
  const supabase = await createClient();
  const [orgs, memberships] = await Promise.all([
    supabase.from("organizations").select("id, name, created_at").order("created_at"),
    supabase.from("memberships").select("organization_id, role").eq("status", "active"),
  ]);
  if (orgs.error || memberships.error) {
    console.error("Admin, organisations: read failed", orgs.error ?? memberships.error);
    return (
      <p role="alert" className="text-danger">
        The organisations could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  const organizations: OrganizationSummary[] = orgs.data.map((org) => {
    const members = memberships.data.filter((m) => m.organization_id === org.id);
    return {
      id: org.id,
      name: org.name,
      createdAt: org.created_at,
      activeMembers: members.length,
      activeAdmins: members.filter((m) => m.role === "admin").length,
      isCurrent: org.id === current?.id,
    };
  });

  return (
    <div className="grid gap-3">
      <p className="max-w-prose text-muted-foreground">
        As a platform admin you manage every organisation, including ones you are not a member of.
        Starting runs and deciding approvals in one still needs a membership there.
      </p>
      <OrganizationsPanel organizations={organizations} />
      <p className="max-w-prose text-xs text-muted-foreground">
        Organisations are not deleted or renamed from the app. Platform admins are added by whoever
        operates the deployment (scripts/create-user.sh --platform-admin), never from a page.
      </p>
    </div>
  );
}
