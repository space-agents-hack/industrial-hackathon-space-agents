import type { Metadata } from "next";
import { Suspense } from "react";

import { AccessRequests } from "@/components/admin/access-requests";
import { type OrganizationSummary, OrganizationsPanel } from "@/components/admin/organizations-panel";
import { NoAccess } from "@/components/no-access";
import { getCurrentOrg } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";

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
  const [orgs, memberships, requests, me] = await Promise.all([
    supabase.from("organizations").select("id, name, created_at").order("created_at"),
    supabase.from("memberships").select("organization_id, role").eq("status", "active"),
    supabase
      .from("access_requests")
      .select("id, email, organization_name, created_at")
      .eq("kind", "create")
      .eq("status", "pending")
      .order("created_at"),
    getSessionUser(supabase),
  ]);
  if (requests.error) console.error("Admin, organisations: access requests failed", requests.error);
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
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Asking for a new organisation</h2>
        <AccessRequests kind="create" requests={requests.data ?? []} />
        <p className="max-w-prose text-xs text-muted-foreground">
          Approve only someone you expect: a new organisation runs on the deployment&apos;s model keys, with no
          monthly cap unless you set one in its Models and limits.
        </p>
      </section>
      <OrganizationsPanel organizations={organizations} myEmail={me?.email ?? null} />
      <p className="max-w-prose text-xs text-muted-foreground">
        One account can belong to several organisations, with a different role in each; its owner
        switches between them in the organisation switcher. Organisations are not deleted from the app; their admins rename them in Models and limits. Platform admins are added by whoever
        operates the deployment (scripts/create-user.sh --platform-admin), never from a page.
      </p>
    </div>
  );
}
