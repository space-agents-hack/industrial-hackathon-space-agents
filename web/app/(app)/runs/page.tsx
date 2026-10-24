import type { Metadata } from "next";
import { Suspense } from "react";

import { NewRunForm } from "@/components/new-run-form";
import { NoAccess } from "@/components/no-access";
import { NoProject } from "@/components/projects/no-project";
import { RunList } from "@/components/run-list";
import { hasNoAccess } from "@/lib/access";
import { fetchCases } from "@/lib/cases";
import { getCurrentOrg } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";
import { runBlockers } from "@/lib/run-readiness";
import { fetchRunList } from "@/lib/runs";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Runs" };

// The runs on the current project's cases (SYS-36), and a quick run that puts a case together and
// starts it in one step. A run without a case (made before cases existed, or whose case was
// deleted) belongs to no project and is not listed here; its own page still opens.
export default function RunsPage() {
  return (
    <div className="grid gap-5">
      <h1 className="sr-only">Runs</h1>
      <Suspense fallback={<p className="text-muted-foreground">Loading runs…</p>}>
        <Runs />
      </Suspense>
    </div>
  );
}

async function Runs() {
  const [{ access, failed, current, permissions }, project] = await Promise.all([
    getCurrentOrg(),
    getCurrentProject(),
  ]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (!current || !project) return <NoProject />;

  const supabase = await createClient();
  const [runs, cases, scope, library] = await Promise.all([
    fetchRunList(supabase, current.id, project.id).catch((error: unknown) => {
      console.error("Runs: could not load runs", error);
      return null;
    }),
    fetchCases(supabase, current.id),
    supabase
      .from("projects")
      .select("all_regulations, project_regulations(regulation_id)")
      .eq("id", project.id)
      .maybeSingle(),
    supabase.from("regulations").select("id", { count: "exact", head: true }).eq("organization_id", current.id),
  ]);
  // The regulation side of lib/run-readiness.ts; the form itself requires a file.
  const blockers = runBlockers({
    files: 1,
    library: library.count ?? 0,
    allRegulations: scope.data?.all_regulations ?? true,
    chosen: scope.data?.project_regulations.length ?? 0,
  });

  return (
    <>
      {/* A viewer gets no form: the database would refuse the run anyway. */}
      {permissions.startRuns ? (
        <NewRunForm
          key={project.id}
          organizationId={current.id}
          projects={[{ id: project.id, name: project.name }]}
          cases={cases.cases.filter((c) => c.project_id === project.id)}
          fixedProject
          blockers={blockers}
        />
      ) : (
        <p className="rounded-md border bg-card px-3 py-2 text-muted-foreground">
          {current.role === "viewer"
            ? "You can read this project's runs. Starting runs and deciding approvals needs the member role."
            : "You manage this organisation as a platform admin. Starting runs and deciding approvals needs a membership in it."}
        </p>
      )}
      <section className="grid gap-2">
        <h2 className="text-sm font-semibold">Runs in {project.name}</h2>
        {runs ? (
          <RunList
            key={project.id}
            initialRuns={runs}
            organizationId={current.id}
            projectId={project.id}
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
