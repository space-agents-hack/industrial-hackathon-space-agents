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

// Why a file cannot be uploaded, or null. Shown next to the file before anything is sent.
export function refusal(file: { name: string; size: number }): string | null {
  if (formatOf(file.name) === null) {
    return `${file.name}: this format is not read yet. Accepted: ${CASE_FORMATS.join(", ")}.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than 25 MB.`;
  return null;
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
