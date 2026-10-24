import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { RunTrace } from "@/components/run-trace";
import { hasNoAccess, permissionsIn } from "@/lib/access";
import { getAccess } from "@/lib/current-org";
import { fetchApprovals, fetchRun, fetchRunEvents } from "@/lib/runs";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Run" };

export default function RunPage({ params, searchParams }: PageProps<"/runs/[id]">) {
  return (
    <div className="grid gap-3">
      <h1 className="sr-only">Run</h1>
      <Link
        href="/"
        className="-ml-1 inline-flex h-7 w-fit items-center rounded-md px-1 text-xs text-muted-foreground hover:text-foreground"
      >
        ← All runs
      </Link>
      {/* The run id and the session are only known at request time, so everything that depends
          on them streams in behind this boundary. */}
      <Suspense fallback={<p className="text-muted-foreground">Loading run…</p>}>
        <Run params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Run({ params, searchParams }: PageProps<"/runs/[id]">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!isUuid(id)) return <Missing />;

  const supabase = await createClient();
  const [run, events, approvals, { access, failed }] = await Promise.all([
    fetchRun(supabase, id),
    fetchRunEvents(supabase, id),
    fetchApprovals(supabase, id),
    getAccess(),
  ]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (!run) return <Missing />;
  // The role in the run's own organisation, not in the one chosen in the header: a link to a run
  // can come from anywhere.
  const canAct = permissionsIn(access, run.organization_id).decideApprovals;
  const { data: onCase } = run.case_id
    ? await supabase.from("cases").select("id, name, project_id, projects(name)").eq("id", run.case_id).maybeSingle()
    : { data: null };

  return (
    <>
      {onCase ? (
        <p className="text-sm text-muted-foreground">
          On case{" "}
          <Link href={`/projects/${onCase.project_id}`} className="hover:text-foreground hover:underline">
            {onCase.projects?.name ?? "Project"}
          </Link>{" "}
          ›{" "}
          <Link
            href={`/projects/${onCase.project_id}/cases/${onCase.id}`}
            className="text-foreground underline-offset-4 hover:underline"
          >
            {onCase.name}
          </Link>
        </p>
      ) : null}
      <RunTrace
        key={run.id}
        initialRun={run}
        initialEvents={events}
        initialApprovals={approvals}
        agentUnreachable={query.agent === "unreachable"}
        canAct={canAct}
      />
    </>
  );
}

function Missing() {
  return <p className="text-muted-foreground">This run does not exist.</p>;
}
