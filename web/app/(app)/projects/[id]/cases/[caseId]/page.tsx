import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { Breadcrumb } from "@/components/projects/breadcrumb";
import { CaseWorkspace } from "@/components/projects/case-workspace";
import { RunRows } from "@/components/projects/run-rows";
import { TitleActions } from "@/components/projects/title-actions";
import { hasNoAccess, permissionsIn } from "@/lib/access";
import { agentHealth } from "@/lib/agent-admin";
import { fetchCaseFiles } from "@/lib/cases";
import { getAccess } from "@/lib/current-org";
import { createClient } from "@/lib/supabase/server";
import { summarizeRun } from "@/lib/trace";
import { isUuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Case" };

export default function CasePage({ params }: PageProps<"/projects/[id]/cases/[caseId]">) {
  return (
    <div className="grid gap-5">
      <Suspense fallback={<p className="text-muted-foreground">Loading the case…</p>}>
        <Case params={params} />
      </Suspense>
    </div>
  );
}

async function Case({ params }: Pick<PageProps<"/projects/[id]/cases/[caseId]">, "params">) {
  const { id, caseId } = await params;
  if (!isUuid(id) || !isUuid(caseId)) return <Missing />;
  const supabase = await createClient();
  const [{ access, failed }, { data: found, error }] = await Promise.all([
    getAccess(),
    supabase
      .from("cases")
      .select("id, name, organization_id, project_id, projects(name, organizations(name))")
      .eq("id", caseId)
      .eq("project_id", id)
      .maybeSingle(),
  ]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (error) {
    console.error("Case: read failed", error);
    return (
      <p role="alert" className="text-danger">
        The case could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }
  if (!found) return <Missing />;

  const canEdit = permissionsIn(access, found.organization_id).startRuns;
  const [files, runs, settings, health] = await Promise.all([
    fetchCaseFiles(supabase, caseId).catch((caught: unknown) => {
      console.error("Case: files read failed", caught);
      return null;
    }),
    supabase
      .from("runs")
      .select("id, created_at, status, model, task")
      .eq("case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.from("organization_settings").select("model").eq("organization_id", found.organization_id).maybeSingle(),
    agentHealth(),
  ]);
  const writerModel = settings.data?.model ?? health?.model ?? "the organisation's model";
  const projectName = found.projects?.name ?? "Project";

  return (
    <>
      <div className="grid gap-1">
        <Breadcrumb
          items={[
            { label: found.projects?.organizations?.name ?? "Organisation", href: "/projects" },
            { label: projectName, href: `/projects/${found.project_id}` },
            { label: found.name },
          ]}
        />
        <TitleActions
          kind="case"
          id={found.id}
          name={found.name}
          canEdit={canEdit}
          deleteWarning="Its files and what was read from them are deleted. Its runs stay, without their case."
          afterDelete={`/projects/${found.project_id}`}
        />
      </div>

      {files ? (
        <CaseWorkspace
          organizationId={found.organization_id}
          caseId={found.id}
          initialFiles={files}
          canEdit={canEdit}
          writerModel={writerModel}
        />
      ) : (
        <p role="alert" className="text-danger">
          The case&apos;s files could not be loaded. Reload the page.
        </p>
      )}

      <section className="grid gap-2" aria-labelledby="case-runs-heading">
        <h2 id="case-runs-heading" className="text-base font-semibold">
          Runs
        </h2>
        <RunRows runs={(runs.data ?? []).map(summarizeRun)} empty="No runs on this case yet." />
      </section>

      <section className="grid gap-1" aria-labelledby="requirements-heading">
        <h2 id="requirements-heading" className="text-base font-semibold">
          Requirements
        </h2>
        <p className="text-sm text-muted-foreground">
          Not stored per case yet: each run&apos;s result is on its run page. The list with a link from each
          requirement to its regulation paragraph comes with the requirements table (issue #4).
        </p>
      </section>
    </>
  );
}

function Missing() {
  return (
    <p className="text-muted-foreground">
      This case does not exist, or it belongs to an organisation you are not in.{" "}
      <Link href="/projects" className="text-primary underline-offset-4 hover:underline">
        All projects
      </Link>
    </p>
  );
}
