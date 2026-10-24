import type { Metadata } from "next";
import { ChevronRight, Package } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { KeepProject } from "@/components/projects/keep-project";
import { Breadcrumb } from "@/components/projects/breadcrumb";
import { NewNamedForm } from "@/components/projects/new-named-form";
import { ProjectRegulations } from "@/components/projects/project-regulations";
import { RunRows } from "@/components/projects/run-rows";
import { TitleActions } from "@/components/projects/title-actions";
import { RelativeTime } from "@/components/relative-time";
import { hasNoAccess, permissionsIn } from "@/lib/access";
import { getAccess } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";
import { ofKind } from "@/lib/subgoal";
import { createClient } from "@/lib/supabase/server";
import { summarizeRun } from "@/lib/trace";
import { isUuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Project" };

export default function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  return (
    <div className="grid gap-5">
      <Suspense fallback={<p className="text-muted-foreground">Loading the project…</p>}>
        <Project params={params} />
      </Suspense>
    </div>
  );
}

async function Project({ params }: Pick<PageProps<"/projects/[id]">, "params">) {
  const { id } = await params;
  if (!isUuid(id)) return <Missing />;
  const supabase = await createClient();
  const [{ access, failed }, current, { data: project, error }] = await Promise.all([
    getAccess(),
    getCurrentProject(),
    supabase
      .from("projects")
      .select(
        "id, name, organization_id, all_regulations, organizations(name), project_regulations(regulation_id), cases(id, name, created_at, kind, case_files(status))",
      )
      .eq("id", id)
      .maybeSingle(),
  ]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (error) {
    console.error("Project: read failed", error);
    return (
      <p role="alert" className="text-danger">
        The project could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }
  if (!project) return <Missing />;

  // The role in the project's own organisation, not the one in the header: a link can come from
  // anywhere.
  const canEdit = permissionsIn(access, project.organization_id).startRuns;
  // This page is the main goal's: sub-goal cases and their runs are on Changes (#42). Deleting the
  // project still deletes both kinds, so the warning counts them all.
  const mainCases = ofKind(project.cases, "main");
  const subgoalCount = project.cases.length - mainCases.length;
  const caseIds = mainCases.map((c) => c.id);
  const [library, runs] = await Promise.all([
    supabase.from("regulations").select("id, code, title").eq("organization_id", project.organization_id),
    caseIds.length === 0
      ? Promise.resolve({ data: [] as never[] })
      : supabase
          .from("runs")
          .select("id, created_at, updated_at, status, model, task, case_id")
          .in("case_id", caseIds)
          .order("created_at", { ascending: false })
          .limit(20),
  ]);
  const regulations = [...(library.data ?? [])].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
  const caseName = new Map(mainCases.map((c) => [c.id, c.name]));
  const cases = [...mainCases].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <>
      <KeepProject projectId={project.id} currentId={current?.id ?? null} />
      <div className="grid gap-1">
        <Breadcrumb
          items={[{ label: project.organizations?.name ?? "Organisation", href: "/projects" }, { label: project.name }]}
        />
        <TitleActions
          kind="project"
          id={project.id}
          name={project.name}
          canEdit={canEdit}
          deleteWarning={`Its ${cases.length} ${cases.length === 1 ? "part" : "parts"}${subgoalCount > 0 ? ` and ${subgoalCount} ${subgoalCount === 1 ? "review" : "reviews"}` : ""}, their files and what was read from them are deleted. Drafts stay, without their part.`}
          afterDelete="/projects"
        />
      </div>

      <section className="grid gap-2" aria-labelledby="cases-heading">
        <h2 id="cases-heading" className="text-lg font-semibold tracking-tight">
          Parts
        </h2>
        {canEdit ? (
          <NewNamedForm
            kind="case"
            organizationId={project.organization_id}
            projectId={project.id}
            placeholder="e.g. Rear lamp housing, revision B"
          />
        ) : null}
        {cases.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-4 text-center text-muted-foreground">
            No parts yet.{canEdit ? " A part is one product's documents: create one, then add its files." : ""}
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {cases.map((c) => {
              const failedFiles = c.case_files.filter((f) => f.status === "failed").length;
              return (
                <li key={c.id}>
                  <Link
                    href={`/projects/${project.id}/cases/${c.id}`}
                    className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                      <Package aria-hidden className="size-4.5" strokeWidth={1.75} />
                    </span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate font-medium">{c.name}</span>
                      <span className="text-[0.8125rem] text-muted-foreground">
                        {c.case_files.length} {c.case_files.length === 1 ? "file" : "files"}
                        {failedFiles > 0 ? <span className="text-danger"> ({failedFiles} not read)</span> : null} ·
                        created <RelativeTime iso={c.created_at} />
                      </span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby="regulations-heading">
        <h2 id="regulations-heading" className="text-lg font-semibold tracking-tight">
          Regulations
        </h2>
        {regulations.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-4 text-center text-muted-foreground">
            The library of this organisation is empty. An admin imports an index file on the{" "}
            <Link href="/regulations" className="text-tint underline-offset-4 hover:underline">
              Regulations
            </Link>{" "}
            page.
          </p>
        ) : (
          <ProjectRegulations
            organizationId={project.organization_id}
            projectId={project.id}
            library={regulations}
            allRegulations={project.all_regulations}
            chosen={project.project_regulations.map((r) => r.regulation_id)}
            canEdit={canEdit}
          />
        )}
        <p className="text-xs text-muted-foreground">
          New regulations come into the library from an index file, on the{" "}
          <Link href="/regulations" className="underline-offset-4 hover:underline">
            Regulations
          </Link>{" "}
          page (admins). The regulation search keeps to this choice for every part of the project; drafts use it
          once the requirement writer is built (issue #4).
        </p>
      </section>

      <section className="grid gap-2" aria-labelledby="runs-heading">
        <h2 id="runs-heading" className="text-lg font-semibold tracking-tight">
          Draft requirements
        </h2>
        <RunRows
          runs={(runs.data ?? []).map((r) => ({ ...summarizeRun(r), where: caseName.get(r.case_id ?? "") }))}
          empty="No drafts on this project's parts yet."
        />
      </section>
    </>
  );
}

function Missing() {
  return (
    <p className="text-muted-foreground">
      This project does not exist, or it belongs to an organisation you are not in.{" "}
      <Link href="/projects" className="text-tint underline-offset-4 hover:underline">
        All projects
      </Link>
    </p>
  );
}
