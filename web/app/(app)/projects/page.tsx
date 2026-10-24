import type { Metadata } from "next";
import { ChevronRight, FolderOpen } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { NoAccess } from "@/components/no-access";
import { PageHeader } from "@/components/page-header";
import { NewNamedForm } from "@/components/projects/new-named-form";
import { RelativeTime } from "@/components/relative-time";
import { hasNoAccess } from "@/lib/access";
import { getCurrentOrg } from "@/lib/current-org";
import { ofKind } from "@/lib/subgoal";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Projects" };

// The project picker, where every sign-in lands (SYS-36). The organisation's projects (ADR-0006:
// organisation → projects → cases → requirements); every member sees every project, there are no
// per-project permissions. With none yet, creating one is the only thing to do.
export default function ProjectsPage() {
  return (
    <div className="grid gap-4">
      <Suspense fallback={<p className="text-muted-foreground">Loading projects…</p>}>
        <Projects />
      </Suspense>
    </div>
  );
}

async function Projects() {
  const { access, failed, current, permissions } = await getCurrentOrg();
  if (!failed && hasNoAccess(access)) redirect("/welcome");
  if (failed) return <NoAccess failed />;
  if (!current) {
    return <p className="text-muted-foreground">There is no organisation yet. Approve or create one in Settings, Organisations.</p>;
  }

  const supabase = await createClient();
  // RLS returns every organisation the person reads; the filter keeps the one in the header.
  const [{ data, error }, library] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, created_at, all_regulations, cases(id, created_at, kind), project_regulations(regulation_id)")
      .eq("organization_id", current.id)
      .order("name"),
    supabase.from("regulations").select("id", { count: "exact", head: true }).eq("organization_id", current.id),
  ]);
  if (error) {
    console.error("Projects: read failed", error);
    return (
      <p role="alert" className="text-danger">
        The projects could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }
  const libraryCount = library.count ?? 0;

  return (
    <>
      <PageHeader
        title="Projects"
        description={
          <>
            A project groups related parts, for example the lamps of one car model, and the regulations they are
            checked against. Everyone in {current.name} sees every project.
          </>
        }
      />
      {permissions.startRuns ? (
        <NewNamedForm kind="project" organizationId={current.id} placeholder="e.g. Rear lamp, model X" />
      ) : null}
      {data.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-6 text-center text-muted-foreground">
          No projects yet.
          {permissions.startRuns
            ? " Create the first one above."
            : " A member or admin of the organisation creates the first one; a viewer cannot."}
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {data.map((project) => {
            // The main goal's cases: a project's sub-goal cases are on Changes, not counted here.
            const cases = ofKind(project.cases, "main");
            const latest = cases.map((c) => c.created_at).sort().at(-1) ?? project.created_at;
            const regulations = project.all_regulations
              ? `all ${libraryCount} regulations`
              : `${project.project_regulations.length} of ${libraryCount} regulations`;
            return (
              <li key={project.id}>
                {/* A plain link, not <Link>: /open stores the choice, and a prefetch would store it on
                    hover. */}
                <a
                  href={`/projects/${project.id}/open`}
                  className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                    <FolderOpen aria-hidden className="size-4.5" strokeWidth={1.75} />
                  </span>
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate font-medium">{project.name}</span>
                    <span className="text-[0.8125rem] text-muted-foreground">
                      {cases.length} {cases.length === 1 ? "part" : "parts"} · {regulations} ·{" "}
                      <RelativeTime iso={latest} />
                    </span>
                  </span>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        Working for another organisation too?{" "}
        <Link href="/welcome" className="text-tint underline-offset-4 hover:underline">
          Ask to join it
        </Link>
        .
      </p>
    </>
  );
}
