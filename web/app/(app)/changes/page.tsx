import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { NewNamedForm } from "@/components/projects/new-named-form";
import { NoProject } from "@/components/projects/no-project";
import { RelativeTime } from "@/components/relative-time";
import { hasNoAccess } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Changes" };

// Certivity's sub-goal (#42): given requirements written from one version of a regulation, which
// of them a newer version changes or removes, and what it adds. It works like the main goal
// (Clemente, 2026-10-24): a sub-goal case in the project, its files dropped on the case page, Run,
// and the run page follows it live, checks and scores the changes file and downloads it.
export default function ChangesPage() {
  return (
    <div className="grid gap-4">
      <h1 className="text-base font-semibold">Regulation changes</h1>
      <Suspense fallback={<p className="text-muted-foreground">Loading the sub-goal cases…</p>}>
        <Changes />
      </Suspense>
    </div>
  );
}

async function Changes() {
  const [{ access, failed, current, permissions }, project] = await Promise.all([getCurrentOrg(), getCurrentProject()]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (!current || !project) return <NoProject />;
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("cases")
    .select("id, name, created_at, case_files(status)")
    .eq("project_id", project.id)
    .eq("kind", "subgoal")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Changes: reading the sub-goal cases failed", error);
    return (
      <p role="alert" className="text-danger">
        The sub-goal cases could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }
  const canEdit = permissions.startRuns;

  return (
    <>
      <p className="text-sm text-muted-foreground">
        One sub-goal case per Certivity folder. Name it after the <span className="font-mono">case_id</span> in its
        files (for example <span className="font-mono">subgoal-heldout</span>), then drop the files of Certivity&apos;s{" "}
        <span className="font-mono">subgoal/&lt;folder&gt;</span> on it: <span className="font-mono">requirements_old.json</span>{" "}
        and <span className="font-mono">files.json</span>, with <span className="font-mono">old.pdf</span> and{" "}
        <span className="font-mono">new.pdf</span> optional. Its run writes the changes file; the run page checks it,
        scores it and downloads it.
      </p>
      {canEdit ? (
        <NewNamedForm
          kind="case"
          caseKind="subgoal"
          organizationId={project.organization_id}
          projectId={project.id}
          placeholder="e.g. subgoal-heldout"
        />
      ) : null}
      {data.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-muted-foreground">
          No sub-goal cases in {project.name} yet.{canEdit ? " Create one above, then add its files." : ""}
        </p>
      ) : (
        <ul className="divide-y rounded-md border bg-card">
          {data.map((c) => {
            const failedFiles = c.case_files.filter((f) => f.status === "failed").length;
            return (
              <li key={c.id}>
                <Link
                  href={`/projects/${project.id}/cases/${c.id}`}
                  className="grid gap-0.5 px-3 py-2 outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-3"
                >
                  <span className="font-mono text-sm font-medium">{c.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {c.case_files.length} {c.case_files.length === 1 ? "file" : "files"}
                    {failedFiles > 0 ? <span className="text-danger"> ({failedFiles} not recognised)</span> : null} ·
                    created <RelativeTime iso={c.created_at} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
