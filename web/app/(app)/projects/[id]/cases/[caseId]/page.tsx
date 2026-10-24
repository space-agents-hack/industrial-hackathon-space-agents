import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { KeepProject } from "@/components/projects/keep-project";
import { Breadcrumb } from "@/components/projects/breadcrumb";
import { CaseWorkspace } from "@/components/projects/case-workspace";
import { DraftScores } from "@/components/projects/draft-scores";
import { RunRows } from "@/components/projects/run-rows";
import { TitleActions } from "@/components/projects/title-actions";
import { hasNoAccess, permissionsIn } from "@/lib/access";
import { agentHealth } from "@/lib/agent-admin";
import { fetchCaseFiles } from "@/lib/cases";
import { getAccess } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";
import { latestChecks } from "@/lib/run-checks";
import { fetchReadiness, runBlockers } from "@/lib/run-readiness";
import { caseKind } from "@/lib/subgoal";
import { createClient } from "@/lib/supabase/server";
import { summarizeRun } from "@/lib/trace";
import { isUuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Part" };

export default function CasePage({ params }: PageProps<"/projects/[id]/cases/[caseId]">) {
  return (
    <div className="grid gap-5">
      <Suspense fallback={<p className="text-muted-foreground">Loading the part…</p>}>
        <Case params={params} />
      </Suspense>
    </div>
  );
}

async function Case({ params }: Pick<PageProps<"/projects/[id]/cases/[caseId]">, "params">) {
  const { id, caseId } = await params;
  if (!isUuid(id) || !isUuid(caseId)) return <Missing />;
  const supabase = await createClient();
  const [{ access, failed }, current, { data: found, error }] = await Promise.all([
    getAccess(),
    getCurrentProject(),
    supabase
      .from("cases")
      .select("id, name, kind, organization_id, project_id, projects(name, organizations(name))")
      .eq("id", caseId)
      .eq("project_id", id)
      .maybeSingle(),
  ]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (error) {
    console.error("Case: read failed", error);
    return (
      <p role="alert" className="text-danger">
        The part could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }
  if (!found) return <Missing />;

  const canEdit = permissionsIn(access, found.organization_id).startRuns;
  const [files, runs, settings, health, readiness] = await Promise.all([
    fetchCaseFiles(supabase, caseId).catch((caught: unknown) => {
      console.error("Case: files read failed", caught);
      return null;
    }),
    supabase
      .from("runs")
      .select("id, created_at, updated_at, status, model, task, agent_version")
      .eq("case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("organization_settings").select("model").eq("organization_id", found.organization_id).maybeSingle(),
    agentHealth(),
    fetchReadiness(supabase, caseId),
  ]);
  // The latest check stored with each of these drafts (#51). A failed read leaves the table
  // without scores, never the page without its drafts.
  const runIds = (runs.data ?? []).map((run) => run.id);
  const { data: checkRows, error: checksError } =
    runIds.length > 0
      ? await supabase
          .from("run_checks")
          .select("run_id, source, checked_at, agent_version, certivity_commit, result")
          .in("run_id", runIds)
      : { data: [], error: null };
  if (checksError) console.error("Case: stored checks read failed", checksError);
  const checks = latestChecks(checkRows ?? []);
  const kind = caseKind(found.kind);
  // Only the regulation side: the files are counted live in the workspace as they are added. A
  // sub-goal case has none (lib/run-readiness.ts): runBlockers reads the kind from readiness.
  const regulationBlockers = readiness ? runBlockers({ ...readiness, files: 1 }) : [];
  const writerModel = settings.data?.model ?? health?.model ?? "the organisation's model";
  const projectName = found.projects?.name ?? "Project";
  const subgoal = kind === "subgoal";

  return (
    <>
      <KeepProject projectId={found.project_id} currentId={current?.id ?? null} />
      <div className="grid gap-1">
        <Breadcrumb
          items={[
            { label: found.projects?.organizations?.name ?? "Organisation", href: "/projects" },
            { label: projectName, href: `/projects/${found.project_id}` },
            // A sub-goal case is listed on Changes, not under the project's Cases (#42).
            ...(subgoal ? [{ label: "Review requirements", href: "/changes" }] : []),
            { label: found.name },
          ]}
        />
        <TitleActions
          kind="case"
          id={found.id}
          name={found.name}
          canEdit={canEdit}
          deleteWarning="Its files and what was read from them are deleted. Its drafts stay, without their part."
          afterDelete={subgoal ? "/changes" : `/projects/${found.project_id}`}
        />
      </div>

      {files ? (
        <CaseWorkspace
          organizationId={found.organization_id}
          caseId={found.id}
          kind={kind}
          initialFiles={files}
          canEdit={canEdit}
          writerModel={writerModel}
          regulationBlockers={regulationBlockers}
        />
      ) : (
        <p role="alert" className="text-danger">
          The part&apos;s files could not be loaded. Reload the page.
        </p>
      )}

      <section className="grid gap-2" aria-labelledby="case-runs-heading">
        <h2 id="case-runs-heading" className="text-lg font-semibold tracking-tight">
          Drafts
        </h2>
        <RunRows runs={(runs.data ?? []).map(summarizeRun)} empty="No drafts for this part yet." />
      </section>

      {(runs.data ?? []).some((run) => run.status === "succeeded") ? (
        <section className="grid gap-2" aria-labelledby="case-scores-heading">
          <h2 id="case-scores-heading" className="text-lg font-semibold tracking-tight">
            Compare drafts
          </h2>
          <DraftScores runs={runs.data ?? []} checks={checks} subgoal={subgoal} />
        </section>
      ) : null}

      {/* A sub-goal run writes changes, not requirements; its file is on the run page. */}
      {subgoal ? null : (
        <section className="grid gap-1" aria-labelledby="requirements-heading">
          <h2 id="requirements-heading" className="text-lg font-semibold tracking-tight">
            Requirements
          </h2>
          <p className="text-sm text-muted-foreground">
            Not stored per part yet: each draft&apos;s result is on its own page. The list with a link from each
            requirement to its regulation paragraph comes with the requirements table (issue #4).
          </p>
        </section>
      )}
    </>
  );
}

function Missing() {
  return (
    <p className="text-muted-foreground">
      This part does not exist, or it belongs to an organisation you are not in.{" "}
      <Link href="/projects" className="text-tint underline-offset-4 hover:underline">
        All projects
      </Link>
    </p>
  );
}
