import type { Metadata } from "next";
import { Suspense } from "react";

import { type RegulationOption, ChangesForm } from "@/components/changes-form";
import { NoAccess } from "@/components/no-access";
import { NoProject } from "@/components/projects/no-project";
import { hasNoAccess } from "@/lib/access";
import { listSubgoalCases } from "@/lib/agent-admin";
import { getCurrentOrg } from "@/lib/current-org";
import { getCurrentProject } from "@/lib/current-project";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Changes" };

// Certivity's sub-goal: given requirements written from one version of a regulation, which of them
// a newer version changes, removes or adds to. The result goes through the same checks as any
// file before anyone uploads it.
export default function ChangesPage() {
  return (
    <div className="grid gap-4">
      <h1 className="text-base font-semibold">Regulation changes</h1>
      <Suspense fallback={<p className="text-muted-foreground">Loading the library…</p>}>
        <Changes />
      </Suspense>
    </div>
  );
}

async function Changes() {
  const [{ access, failed, current }, project] = await Promise.all([getCurrentOrg(), getCurrentProject()]);
  if (failed || hasNoAccess(access)) return <NoAccess failed={failed} />;
  if (!current || !project) return <NoProject />;
  const supabase = await createClient();

  const [{ data, error }, cases, scope] = await Promise.all([
    supabase
      .from("regulations")
      .select("id, code, regulation_versions(id, version_label, role)")
      .eq("organization_id", current.id),
    listSubgoalCases(),
    supabase
      .from("projects")
      .select("all_regulations, project_regulations(regulation_id)")
      .eq("id", project.id)
      .maybeSingle(),
  ]);
  if (error || scope.error) {
    console.error("Changes: reading the library failed", error);
    return (
      <p role="alert" className="text-danger">
        The library could not be loaded. Check that the database is reachable and reload.
      </p>
    );
  }

  // The project's regulations (SYS-36), and of those only the ones with two versions can change;
  // "UN R3" before "UN R10".
  const all = scope.data?.all_regulations ?? true;
  const chosen = new Set(scope.data?.project_regulations.map((r) => r.regulation_id) ?? []);
  const regulations: RegulationOption[] = data
    .filter((r) => (all || chosen.has(r.id)) && r.regulation_versions.length >= 2)
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }))
    .map((r) => ({
      id: r.id,
      code: r.code,
      versions: r.regulation_versions
        .map((v) => ({ id: v.id, label: v.version_label, role: v.role }))
        .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true })),
    }));

  if (regulations.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground">
        No regulation of {project.name} has two versions yet. Import an index file on the Regulations page
        first, or include such a regulation in the project.
      </p>
    );
  }
  return <ChangesForm org={current.id} regulations={regulations} cases={cases} />;
}
