// Case files: what the engineer uploads with a run (issue #8, docs/se IF-1). Pure, so node --test
// runs it without a bundler.
//
// The formats here are the database's (run_files.format check in
// supabase/migrations/20261024160000_case_files.sql) and the agent's readers
// (agent/agent_service/domain/ingest.py). case-files.test.ts fails if the web and the migration
// stop agreeing; the database refuses anything else either way.

export const CASE_FILES_BUCKET = "case-files";

export const CASE_FORMATS = [
  "md",
  "txt",
  "csv",
  "json",
  "png",
  "jpeg",
  "webp",
  "pdf",
  "docx",
  "xlsx",
  "step",
  "iges",
  "stl",
] as const;

export type CaseFormat = (typeof CASE_FORMATS)[number];

const EXTENSIONS: Record<string, CaseFormat> = {
  ...Object.fromEntries(CASE_FORMATS.map((f) => [f, f])),
  markdown: "md",
  jpg: "jpeg",
  stp: "step",
  igs: "iges",
};

// The same numbers as the migration: the bucket's file_size_limit and start_run()'s file count.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20;

// For the file picker. Extensions, not media types: browsers report CAD files as "" or
// application/octet-stream, so a media-type filter would hide them.
export const ACCEPT = Object.keys(EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(",");

export function formatOf(filename: string): CaseFormat | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSIONS[filename.slice(dot + 1).toLowerCase()] ?? null;
}

// Storage keys allow a narrow set of characters, and a name like "Spec (v2) ä.pdf" is common.
// The original name is kept in run_files.filename; this is only the object's key.
export function storageName(filename: string): string {
  const cleaned = filename.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  return cleaned.slice(-120) || "file";
}

export function storagePath(organizationId: string, uploadId: string, index: number, filename: string): string {
  // The index keeps two files with the same cleaned name apart.
  return `${organizationId}/${uploadId}/${index + 1}-${storageName(filename)}`;
}

// A case's file (ADR-0006): the case id is the second segment, which the case_files insert policy
// checks, and the position keeps two uploads of the same name apart.
export function casePath(organizationId: string, caseId: string, position: number, filename: string): string {
  return storagePath(organizationId, caseId, position, filename);
}

// The statuses the agent moves a case file through (case_files.status).
export type CaseFileStatus = "pending" | "parsing" | "parsed" | "failed";

export function isSettled(status: string): boolean {
  return status === "parsed" || status === "failed";
}

// Why a file cannot be uploaded, or null. Shown next to the file before anything is sent.
export function refusal(file: { name: string; size: number }): string | null {
  if (formatOf(file.name) === null) {
    return `${file.name}: this format is not read yet. Accepted: ${CASE_FORMATS.join(", ")}.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than 25 MB.`;
  return null;
}

// Certivity's case folders ship expected.json beside the inputs, and a part takes .json files, so a
// picked folder would hand the answer key to every model of the run: the dev score goes up and says
// nothing about the held-out case (SYS-42). Decided by content and not by name, because a renamed
// copy gives the answers away the same; a run's own output has the same shape. The agent applies
// the same rule as a backstop (ingest.py, answers_in), so keep the two in step.
export function answersIn(text: string): "A requirements file" | "A changes file" | null {
  if (!text.trimStart().startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { requirements, changes } = value as { requirements?: unknown; changes?: unknown };
  // A spec with a list of plain requirement strings is case content, not an answer file.
  const cites = (r: unknown) => typeof r === "object" && r !== null && ("source" in r || "regulation" in r);
  if (Array.isArray(requirements) && requirements.some(cites)) return "A requirements file";
  if (Array.isArray(changes)) return "A changes file";
  return null;
}

const ANSWER_FORMATS: ReadonlySet<CaseFormat> = new Set(["json", "md", "txt"]);

type Screenable = { name: string; size: number; text(): Promise<string> };

// What goes up from a pick for a part: other formats and sizes refused with the reason, answer
// files held back with their own message. Only text files are read, and only to decide.
export async function screenCaseFiles<T extends Screenable>(
  files: readonly T[],
): Promise<{ keep: T[]; problems: string[]; answerFiles: string[] }> {
  const result = { keep: [] as T[], problems: [] as string[], answerFiles: [] as string[] };
  for (const file of files) {
    const reason = refusal(file);
    if (reason) {
      result.problems.push(reason);
      continue;
    }
    const format = formatOf(file.name);
    const kind = format && ANSWER_FORMATS.has(format) ? answersIn(await file.text().catch(() => "")) : null;
    if (kind) {
      result.answerFiles.push(
        `${file.name}: ${kind.toLowerCase()} in Certivity's format (an answer key, or a run's output). It is not added to the part, so no run can read it; the checks already have Certivity's answer keys.`,
      );
      continue;
    }
    result.keep.push(file);
  }
  return result;
}

export function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// What the browser sends to POST /api/runs for each uploaded file.
export type UploadedFile = {
  storage_path: string;
  filename: string;
  format: CaseFormat;
  media_type: string | null;
  bytes: number;
  sha256: string | null;
};

// How the case page shows a file as it was uploaded (SYS-31, #45). The browser shows these by
// itself; Word, Excel and CAD files it cannot, so for those the page offers the download and what
// was read from them.
export type FileView = "markdown" | "text" | "json" | "image" | "pdf" | "download";

const VIEWS: Record<CaseFormat, FileView> = {
  md: "markdown",
  txt: "text",
  csv: "text",
  json: "json",
  png: "image",
  jpeg: "image",
  webp: "image",
  pdf: "pdf",
  docx: "download",
  xlsx: "download",
  step: "download",
  iges: "download",
  stl: "download",
};

// The stored format, else the name's: a row from before the format column was read still opens.
export function viewOf(format: string | null, filename: string): FileView {
  const known = (CASE_FORMATS as readonly string[]).includes(format ?? "") ? (format as CaseFormat) : formatOf(filename);
  return known ? VIEWS[known] : "download";
}

// The media type the page gives the bytes before showing them. Not the one stored with the
// object: browsers report .md and CAD files as "" and the upload then stores
// application/octet-stream, which an <iframe> or <img> would download instead of showing.
export function displayType(view: FileView, format: string | null, filename: string): string {
  if (view === "pdf") return "application/pdf";
  if (view === "image") {
    const known = format === "png" || format === "jpeg" || format === "webp" ? format : formatOf(filename);
    return `image/${known === "jpeg" ? "jpeg" : known === "webp" ? "webp" : "png"}`;
  }
  return "text/plain;charset=utf-8";
}

// A text file is shown up to this many characters: 25 MB of CSV in one <pre> freezes the tab, and
// past a screenful nobody reads it there. The download has all of it.
export const TEXT_PREVIEW_CHARS = 200_000;

export function textPreview(view: FileView, raw: string): { text: string; cut: boolean } {
  let text = raw;
  if (view === "json") {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      // Shown as it is: a file the agent could not parse either is worth seeing raw.
    }
  }
  return text.length > TEXT_PREVIEW_CHARS
    ? { text: text.slice(0, TEXT_PREVIEW_CHARS), cut: true }
    : { text, cut: false };
}
