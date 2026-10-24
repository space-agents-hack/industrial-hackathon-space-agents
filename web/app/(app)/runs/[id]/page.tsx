import type { Metadata } from "next";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/projects/breadcrumb";
import { RunTrace } from "@/components/run-trace";
import { hasNoAccess, permissionsIn } from "@/lib/access";
import { getAccess } from "@/lib/current-org";
import { fetchApprovals, fetchRun, fetchRunEvents } from "@/lib/runs";
import { caseKind } from "@/lib/subgoal";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Draft" };

export default function RunPage({ params, searchParams }: PageProps<"/runs/[id]">) {
  return (
    <div className="grid gap-5">
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
    ? await supabase.from("cases").select("id, name, project_id, kind, projects(name)").eq("id", run.case_id).maybeSingle()
    : { data: null };

  return (
    <>
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={
              onCase
                ? [
                    { label: onCase.projects?.name ?? "Project", href: `/projects/${onCase.project_id}` },
                    // A sub-goal case is listed on Changes, not under the project's Cases (#42).
                    ...(caseKind(onCase.kind) === "subgoal" ? [{ label: "Review requirements", href: "/changes" }] : []),
                    { label: onCase.name, href: `/projects/${onCase.project_id}/cases/${onCase.id}` },
                    { label: "Draft" },
                  ]
                : [{ label: "Draft requirements", href: "/runs" }, { label: "Draft" }]
            }
          />
        }
        title={onCase ? (caseKind(onCase.kind) === "subgoal" ? `Review of ${onCase.name}` : `Draft for ${onCase.name}`) : "Draft"}
      />
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
