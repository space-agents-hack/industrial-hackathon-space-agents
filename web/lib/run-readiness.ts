import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

// What a run needs before it may start (Clemente, 2026-10-24, first experiments): a case with at
// least one file, and at least one regulation the case's project uses. Without a regulation the
// writer has nothing to cite and the run ends with no requirements after minutes of model time;
// refusing up front costs nothing. Checked in the browser to grey the button with the reason, and
// again in POST /api/runs, which is what counts.

export type Readiness = {
  files: number;
  // Regulations in the organisation's library, and how many the project chose (when not all).
  library: number;
  allRegulations: boolean;
  chosen: number;
};

export function runBlockers(r: Readiness): string[] {
  const blockers: string[] = [];
  if (r.files === 0) blockers.push("The case has no files yet: add at least one.");
  if (r.library === 0) {
    blockers.push("The organisation's regulation library is empty: an admin imports an index file on Regulations.");
  } else if (!r.allRegulations && r.chosen === 0) {
    blockers.push("The project uses no regulation: choose at least one on the project page.");
  }
  return blockers;
}

type Client = SupabaseClient<Database>;

// The same numbers for one case, read as the signed-in person. Null when the case is not theirs.
export async function fetchReadiness(supabase: Client, caseId: string): Promise<Readiness | null> {
  const { data: found, error } = await supabase
    .from("cases")
    .select("organization_id, projects(all_regulations, project_regulations(regulation_id))")
    .eq("id", caseId)
    .maybeSingle();
  if (error) console.error(`readiness: case ${caseId} read failed`, error);
  if (!found) return null;
  const [files, library] = await Promise.all([
    supabase.from("case_files").select("id", { count: "exact", head: true }).eq("case_id", caseId),
    supabase
      .from("regulations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", found.organization_id),
  ]);
  return {
    files: files.count ?? 0,
    library: library.count ?? 0,
    allRegulations: found.projects?.all_regulations ?? true,
    chosen: found.projects?.project_regulations.length ?? 0,
  };
}
