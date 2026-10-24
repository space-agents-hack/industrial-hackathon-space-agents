import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { type MyRequest, AccessRequestForms } from "@/components/onboarding/access-request-forms";
import { hasNoAccess } from "@/lib/access";
import { getAccess } from "@/lib/current-org";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Join an organisation" };

// Where an account with no organisation lands (SYS-35): after sign-up, and whenever they open the
// app before an admin let them in. Someone already in an organisation can come here to ask for
// another one.
export default function WelcomePage() {
  return (
    <div className="grid max-w-2xl gap-4">
      <h1 className="page-title">Join an organisation</h1>
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Welcome />
      </Suspense>
    </div>
  );
}

async function Welcome() {
  const supabase = await createClient();
  const [{ access, failed }, user, organizations, requests] = await Promise.all([
    getAccess(),
    getSessionUser(supabase),
    supabase.rpc("joinable_organizations"),
    supabase
      .from("access_requests")
      .select("id, kind, organization_name, status, created_at, user_id")
      .in("status", ["pending", "declined"])
      .order("created_at", { ascending: false }),
  ]);
  if (failed || organizations.error || requests.error || !user) {
    console.error("Welcome: read failed", organizations.error ?? requests.error);
    return (
      <p role="alert" className="text-danger">
        Your access could not be checked. Check that the database is reachable and reload.
      </p>
    );
  }
  // RLS returns the person's own requests here, plus the ones they decide as an admin: keep theirs.
  const mine: MyRequest[] = requests.data
    .filter((r) => r.user_id === user.id)
    .map((r) => ({ ...r, kind: r.kind === "create" ? "create" : "join" }));
  return (
    <>
      {hasNoAccess(access) ? (
        <p className="max-w-prose">
          You are signed in as <span className="font-medium">{user.email}</span>, but not part of an organisation yet.
          Projects, parts and regulations belong to an organisation, so start by getting into one.
        </p>
      ) : (
        <p className="max-w-prose">
          You are already in {access.organizations.map((o) => o.name).join(", ")}.{" "}
          <Link href="/projects" className="text-tint underline-offset-4 hover:underline">
            Go to your projects
          </Link>
          , or ask to join another organisation below.
        </p>
      )}
      <AccessRequestForms userId={user.id} organizations={organizations.data} requests={mine} />
    </>
  );
}
