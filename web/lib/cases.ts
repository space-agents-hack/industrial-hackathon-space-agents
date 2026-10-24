import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

// Projects and cases of one organisation (ADR-0006). Read on the server for the first render and
// in the browser when a case is picked, like lib/runs.ts.
type Client = SupabaseClient<Database>;

export type ProjectOption = { id: string; name: string };
export type CaseOption = { id: string; name: string; project_id: string };
export type CaseFileView = {
  id: string;
  filename: string;
  position: number;
  bytes: number;
  status: string;
  error: string | null;
  notes: string[];
};

// RLS returns every organisation the person reads; the filter scopes it to the one on screen.
// A failed read gives empty lists: the form still works, it just offers only "new".
export async function fetchCases(
  supabase: Client,
  organizationId: string,
): Promise<{ projects: ProjectOption[]; cases: CaseOption[] }> {
  const [projects, cases] = await Promise.all([
    supabase.from("projects").select("id, name").eq("organization_id", organizationId).order("name"),
    supabase
      .from("cases")
      .select("id, name, project_id")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false }),
  ]);
  if (projects.error || cases.error) {
    console.error("could not load projects and cases", projects.error ?? cases.error);
    return { projects: [], cases: [] };
  }
  return { projects: projects.data, cases: cases.data };
}

export async function fetchCaseFiles(supabase: Client, caseId: string): Promise<CaseFileView[]> {
  const { data, error } = await supabase
    .from("case_files")
    .select("id, filename, position, bytes, status, error, notes")
    .eq("case_id", caseId)
    .order("position")
    .order("created_at");
  if (error) throw new Error(`The case's files could not be read: ${error.message}`);
  return data.map((f) => ({
    ...f,
    notes: Array.isArray(f.notes) ? f.notes.filter((n): n is string => typeof n === "string") : [],
  }));
}
