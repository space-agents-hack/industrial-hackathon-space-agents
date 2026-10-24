import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminNotice } from "@/components/admin/admin-notice";
import { AccessRequests } from "@/components/admin/access-requests";
import { AddPersonForm } from "@/components/admin/add-person-form";
import { type Person, PeopleTable } from "@/components/admin/people-table";
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/access";
import { adminPage } from "@/lib/admin-page";
import { getSessionUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "People" };

export default function PeoplePage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">Loading people…</p>}>
      <People />
    </Suspense>
  );
}

async function People() {
  const page = await adminPage();
  if (!page.ok) return <AdminNotice reason={page.reason} />;
  const { supabase, org } = page;

  const [{ data: rows, error }, me, requests] = await Promise.all([
    supabase.rpc("organization_people", { org: org.id }),
    getSessionUser(supabase),
    supabase
      .from("access_requests")
      .select("id, email, organization_name, created_at")
      .eq("organization_id", org.id)
      .eq("kind", "join")
      .eq("status", "pending")
      .order("created_at"),
  ]);
  if (requests.error) console.error("Admin, people: access requests failed", requests.error);
  if (error) {
    console.error("Admin, people: organization_people failed", error);
    return (
      <p role="alert" className="text-danger">
        The people could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  // One question per person. can_reset_password depends on every organisation the person is in,
  // which this page cannot see, so the database answers. Organisations here are a handful of
  // people; this would need a set-returning version past a few hundred.
  const resettable = await Promise.all(
    rows.map(async (row) => {
      const { data, error: checkError } = await supabase.rpc("can_reset_password", { member: row.user_id });
      if (checkError) console.error("Admin, people: can_reset_password failed", checkError);
      return data === true;
    }),
  );

  const people: Person[] = rows.map((row, index) => ({
    userId: row.user_id,
    email: row.email,
    role: row.role,
    status: row.status,
    // The generated type says string; a person who never signed in has null.
    lastSignInAt: (row.last_sign_in_at as string | null) ?? null,
    canResetPassword: resettable[index],
    isYou: row.user_id === me?.id,
  }));

  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Asking to join {org.name}</h2>
        <AccessRequests kind="join" requests={requests.data ?? []} />
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">People in {org.name}</h2>
        <PeopleTable org={org.id} people={people} />
        <ul className="grid gap-0.5 text-xs text-muted-foreground">
          {ROLES.map((role) => (
            <li key={role}>
              {ROLE_LABELS[role]}: {ROLE_DESCRIPTIONS[role]}.
            </li>
          ))}
          <li>
            Suspended: keeps their history, cannot see or do anything here. An organisation always
            keeps at least one active admin.
          </li>
          <li>
            Set password appears only where you manage every organisation the person belongs to.
          </li>
        </ul>
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Add a person</h2>
        <AddPersonForm org={org.id} />
      </section>
    </div>
  );
}
