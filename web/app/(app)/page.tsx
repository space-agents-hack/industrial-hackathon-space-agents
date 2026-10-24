import type { Metadata } from "next";
import { Suspense } from "react";

import { NewRunForm } from "@/components/new-run-form";
import { NoAccess } from "@/components/no-access";
import { RunList } from "@/components/run-list";
import { hasNoAccess } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import { fetchCases } from "@/lib/cases";
import { fetchRunList } from "@/lib/runs";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Runs" };

export default function HomePage() {
  return (
    <div className="grid gap-5">
      <h1 className="sr-only">Runs</h1>
      {/* The organisation and the role are only known at request time. */}
      <Suspense fallback={<p className="text-muted-foreground">Loading runs…</p>}>
        <Runs />
      </Suspense>
    </div>
  );
}

async function Runs() {
  const { access, failed, current, permissions } = await getCurrentOrg();
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (!current) {
    // Only a platform admin gets here without an organisation.
    return (
      <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
        There is no organisation yet. Create one in Admin, Organisations.
      </p>
    );
  }

  const supabase = await createClient();
  const [runs, cases] = await Promise.all([
    fetchRunList(supabase, current.id).catch((error: unknown) => {
      console.error("Home: could not load runs", error);
      return null;
    }),
    fetchCases(supabase, current.id),
  ]);

  return (
    <>
      {/* A viewer gets no form: the database would refuse the run anyway. */}
      {permissions.startRuns ? (
        <NewRunForm key={current.id} organizationId={current.id} {...cases} />
      ) : (
        <p className="rounded-md border bg-card px-3 py-2 text-muted-foreground">
          {current.role === "viewer"
            ? "You can read this organisation's runs. Starting runs and deciding approvals needs the member role."
            : "You manage this organisation as a platform admin. Starting runs and deciding approvals needs a membership in it."}
        </p>
      )}
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Recent runs</h2>
        {runs ? (
          <RunList
            key={current.id}
            initialRuns={runs}
            organizationId={current.id}
            canStart={permissions.startRuns}
          />
        ) : (
          <p role="alert" className="text-danger">
            The runs could not be loaded. Check that the database is reachable and reload.
          </p>
        )}
      </section>
    </>
  );
}
