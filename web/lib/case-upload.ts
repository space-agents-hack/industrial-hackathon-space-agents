import type { SupabaseClient } from "@supabase/supabase-js";

import { CASE_FILES_BUCKET, casePath, formatOf, isSettled } from "@/lib/case-files";
import { type CaseFileView, fetchCaseFiles } from "@/lib/cases";
import type { Database } from "@/lib/database.types";

// What the browser does with a case's files, shared by the quick-run form on the home page and
// the case page: upload to the private bucket as the signed-in user, add the rows, ask the agent
// to parse, wait. Files go straight to Storage because a Vercel function refuses bodies over
// 4.5 MB (issue #8).
type Client = SupabaseClient<Database>;

// How long to wait for the parse before giving up waiting. The files keep their status; the page
// shows it, which beats a spinner that never ends on a file a dead request left `parsing`.
export const PARSE_WAIT_MS = 10 * 60 * 1000;
// Polling, not Realtime: one select every two seconds is cheap, and it needs no channel that can
// silently drop.
const POLL_MS = 2000;

async function sha256(file: File): Promise<string | null> {
  // Recorded so a run can later be matched to the exact file it read. Optional: a browser
  // without SubtleCrypto (plain http on a LAN address) still uploads.
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadCaseFiles(
  supabase: Client,
  organizationId: string,
  caseId: string,
  files: File[],
  existing: Pick<CaseFileView, "position">[],
  onProgress: (text: string) => void,
): Promise<void> {
  const first = existing.reduce((max, f) => Math.max(max, f.position + 1), 0);
  const rows = [];
  for (const [index, file] of files.entries()) {
    onProgress(`Uploading ${file.name} (${index + 1} of ${files.length})…`);
    const position = first + index;
    const path = casePath(organizationId, caseId, position, file.name);
    const { error } = await supabase.storage
      .from(CASE_FILES_BUCKET)
      .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (error) throw new Error(`${file.name} could not be uploaded: ${error.message}`);
    rows.push({
      case_id: caseId,
      organization_id: organizationId,
      position,
      storage_path: path,
      filename: file.name.slice(0, 255),
      // refusal() let only known formats into the list.
      format: formatOf(file.name)!,
      media_type: file.type || null,
      bytes: file.size,
      sha256: await sha256(file),
    });
  }
  if (rows.length === 0) return;
  const { error } = await supabase.from("case_files").insert(rows);
  if (error) throw new Error(`The files were uploaded but not added to the case: ${error.message}`);
}

// Asks the agent to parse what is pending, then waits until every file is parsed or failed.
export async function parseCase(
  supabase: Client,
  caseId: string,
  onRows: (rows: CaseFileView[]) => void,
  onProgress: (text: string) => void,
): Promise<CaseFileView[]> {
  let rows = await fetchCaseFiles(supabase, caseId);
  onRows(rows);
  if (rows.every((f) => isSettled(f.status))) return rows;
  onProgress("Reading the files…");
  const response = await fetch(`/api/cases/${caseId}/ingest`, { method: "POST" });
  if (!response.ok) {
    const body: { error?: string } = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `The files could not be sent to the agent (${response.status}).`);
  }
  const until = Date.now() + PARSE_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    rows = await fetchCaseFiles(supabase, caseId);
    onRows(rows);
    const done = rows.filter((f) => isSettled(f.status)).length;
    if (done === rows.length) break;
    onProgress(`Reading the files… ${done} of ${rows.length} done`);
  }
  return rows;
}

// Starts a run on a case. Returns the path of the run page to open.
export async function startCaseRun(
  organizationId: string,
  caseId: string,
  task: string,
  model: string | null,
): Promise<string> {
  const response = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, organization_id: organizationId, case_id: caseId, model: model || undefined }),
  });
  const body: { id?: string; warning?: string; error?: string } = await response.json().catch(() => ({}));
  if (!response.ok || !body.id) throw new Error(body.error ?? `The run could not be started (${response.status}).`);
  // With a warning the run exists but the agent never heard of it; the run page says so and
  // offers Send to agent.
  return `/runs/${body.id}${body.warning ? "?agent=unreachable" : ""}`;
}

// The objects a file left in Storage: the upload, and the pages the agent rendered from it.
// Read before the row goes, since its blocks go with it.
async function objectsOf(supabase: Client, fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const [files, blocks] = await Promise.all([
    supabase.from("case_files").select("storage_path").in("id", fileIds),
    supabase.from("case_file_blocks").select("image_path").in("file_id", fileIds).not("image_path", "is", null),
  ]);
  // An uploaded image is its own block, so its path can appear twice.
  return [
    ...new Set([
      ...(files.data ?? []).map((f) => f.storage_path),
      ...(blocks.data ?? []).flatMap((b) => (b.image_path ? [b.image_path] : [])),
    ]),
  ];
}

// The row first, then the bytes: the database is what the app shows, so a failure after the row
// leaves bytes nobody can reach (the purge script empties the bucket) rather than a file listed in
// the case that no longer exists. Returns a warning when the bytes could not all be removed.
async function removeObjects(supabase: Client, paths: string[]): Promise<string | null> {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await supabase.storage.from(CASE_FILES_BUCKET).remove(paths.slice(i, i + 100));
    if (error) return `Removed from the case, but some stored copies were not deleted: ${error.message}`;
  }
  return null;
}

export async function removeCaseFile(supabase: Client, fileId: string): Promise<string | null> {
  const paths = await objectsOf(supabase, [fileId]);
  const { error, count } = await supabase.from("case_files").delete({ count: "exact" }).eq("id", fileId);
  if (error) throw new Error(`The file could not be removed: ${error.message}`);
  if (count === 0) throw new Error("The file could not be removed: it needs the member role in this organisation.");
  return removeObjects(supabase, paths);
}

async function fileIdsOf(supabase: Client, column: "case_id" | "project_id", id: string): Promise<string[]> {
  if (column === "case_id") {
    const { data } = await supabase.from("case_files").select("id").eq("case_id", id);
    return (data ?? []).map((f) => f.id);
  }
  const { data } = await supabase.from("cases").select("case_files(id)").eq("project_id", id);
  return (data ?? []).flatMap((c) => c.case_files.map((f) => f.id));
}

export async function deleteCase(supabase: Client, caseId: string): Promise<string | null> {
  const paths = await objectsOf(supabase, await fileIdsOf(supabase, "case_id", caseId));
  const { error, count } = await supabase.from("cases").delete({ count: "exact" }).eq("id", caseId);
  if (error) throw new Error(`The case could not be deleted: ${error.message}`);
  if (count === 0) throw new Error("The case could not be deleted: it needs the member role in this organisation.");
  return removeObjects(supabase, paths);
}

export async function deleteProject(supabase: Client, projectId: string): Promise<string | null> {
  const paths = await objectsOf(supabase, await fileIdsOf(supabase, "project_id", projectId));
  const { error, count } = await supabase.from("projects").delete({ count: "exact" }).eq("id", projectId);
  if (error) throw new Error(`The project could not be deleted: ${error.message}`);
  if (count === 0) throw new Error("The project could not be deleted: it needs the member role in this organisation.");
  return removeObjects(supabase, paths);
}
