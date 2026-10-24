// Request-body checks for the route handlers. Two endpoints do not justify a validation library.

import { MAX_FILE_BYTES, MAX_FILES, formatOf, type UploadedFile } from "./case-files.ts";

export const TASK_MAX_LENGTH = 20000;
export const NOTE_MAX_LENGTH = 2000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Postgres `length()` counts characters, JavaScript `.length` counts UTF-16 units. Count the way
// the database does so a task it would accept is not rejected here.
function characters(text: string): number {
  return Array.from(text).length;
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

// The organisation comes from the form, not from the `org` cookie: it is the one the person saw
// on the page when they pressed Start, even if another tab has switched since. RLS decides
// whether they may start runs there.
//
// With case files the note is optional: the run list previews the task, so a run started from
// files alone is named after them instead of an empty line.
export function parseNewRun(
  body: unknown,
): Parsed<{ task: string; organizationId: string; files: UploadedFile[] }> {
  if (!isRecord(body) || typeof body.task !== "string") {
    return { ok: false, error: 'Expected a JSON body like { "task": "...", "organization_id": "..." }.' };
  }
  if (!isUuid(body.organization_id)) return { ok: false, error: "Choose an organisation first." };
  const files = parseFiles(body.files, body.organization_id);
  if (!files.ok) return files;
  let task = body.task.trim();
  if (task === "" && files.value.length > 0) {
    task = `Case files: ${files.value.map((f) => f.filename).join(", ")}`.slice(0, TASK_MAX_LENGTH);
  }
  if (task === "") return { ok: false, error: "Give a specification or attach at least one file." };
  if (characters(task) > TASK_MAX_LENGTH) {
    return { ok: false, error: `The task is longer than ${TASK_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: { task, organizationId: body.organization_id, files: files.value } };
}

const SHA256 = /^[0-9a-f]{64}$/;

function parseFiles(value: unknown, organizationId: string): Parsed<UploadedFile[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: "files must be a list." };
  if (value.length > MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} files per run.` };
  const files: UploadedFile[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.storage_path !== "string" || typeof item.filename !== "string") {
      return { ok: false, error: "Each file needs a storage_path and a filename." };
    }
    const format = formatOf(item.filename);
    if (format === null || item.format !== format) {
      return { ok: false, error: `${item.filename}: this format is not accepted.` };
    }
    // The database checks this too; refusing here gives a message a person can act on.
    if (!item.storage_path.startsWith(`${organizationId}/`)) {
      return { ok: false, error: `${item.filename} was not uploaded to this organisation.` };
    }
    if (typeof item.bytes !== "number" || !Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_FILE_BYTES) {
      return { ok: false, error: `${item.filename}: the size must be between 1 byte and 25 MB.` };
    }
    files.push({
      storage_path: item.storage_path,
      filename: item.filename.slice(0, 255),
      format,
      media_type: typeof item.media_type === "string" && item.media_type !== "" ? item.media_type.slice(0, 255) : null,
      bytes: item.bytes,
      sha256: typeof item.sha256 === "string" && SHA256.test(item.sha256) ? item.sha256 : null,
    });
  }
  return { ok: true, value: files };
}

export type Decision = "approved" | "denied";

export function parseDecision(body: unknown): Parsed<{ decision: Decision; note: string | null }> {
  if (!isRecord(body) || (body.decision !== "approved" && body.decision !== "denied")) {
    return { ok: false, error: 'Expected a JSON body like { "decision": "approved" | "denied" }.' };
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return { ok: false, error: "The note must be text." };
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (characters(note) > NOTE_MAX_LENGTH) {
    return { ok: false, error: `The note is longer than ${NOTE_MAX_LENGTH} characters.` };
  }
  return { ok: true, value: { decision: body.decision, note: note === "" ? null : note } };
}
