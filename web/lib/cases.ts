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
  // What the case page needs to show the file as uploaded (#45): the stored format and its object.
  format: string;
  storage_path: string;
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
      // The run form on Runs finds requirements; a sub-goal case offered there would get a run that
      // ignores what the case is for (#42).
      .eq("kind", "main")
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
    .select("id, filename, format, storage_path, position, bytes, status, error, notes")
    .eq("case_id", caseId)
    .order("position")
    .order("created_at");
  if (error) throw new Error(`The case's files could not be read: ${error.message}`);
  return data.map((f) => ({
    ...f,
    notes: Array.isArray(f.notes) ? f.notes.filter((n): n is string => typeof n === "string") : [],
  }));
}

// What a file was read as (case_file_blocks): the text or image of each page, and which parser
// or model produced it. Read when a file is opened on the case page, not with the list: a long
// PDF is hundreds of blocks.
export type CaseBlockView = {
  seq: number;
  kind: string;
  page: number | null;
  label: string;
  text: string | null;
  image_path: string | null;
  parser: string;
};

export async function fetchCaseBlocks(supabase: Client, fileId: string): Promise<CaseBlockView[]> {
  const { data, error } = await supabase
    .from("case_file_blocks")
    .select("seq, kind, page, label, text, image_path, parser")
    .eq("file_id", fileId)
    .order("seq")
    .limit(1000);
  if (error) throw new Error(`What was read from this file could not be loaded: ${error.message}`);
  return data;
}

// "pypdf" reads as "read by pypdf"; a model's block says so, because a model can reword what it
// read and a parser cannot (SYS-27).
export function describeParser(parser: string): string {
  return parser.startsWith("model:") ? `described by a model (${parser.slice(6)})` : `read by ${parser}`;
}

// What a person calls each thing. The table is `cases` (and Certivity says "case"), but in the app
// a case is a part (Clemente, 2026-10-24): a product's documents, run as one. Code and database
// keep "case"; only the words on screen change, so they are made here and nowhere else.
export function nounOf(kind: string): string {
  return kind === "case" ? "part" : kind;
}

// A name the database refused as a duplicate, said the way the person would fix it.
export function nameTakenMessage(code: string | undefined, what: string, name: string): string | null {
  return code === "23505" ? `A ${nounOf(what)} called "${name}" already exists here.` : null;
}
