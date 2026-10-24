// The regulation library's page and routes: checks on an uploaded index and the words for an
// import's state. The agent reads the index again and is the one that decides
// (agent/agent_service/domain/regulations.py); this side only catches a wrong file before it is
// sent, and says what the file contains.

import { type Parsed, isUuid } from "./validation.ts";

// The database refuses more (create_regulation_import); the challenge's index is about 60 KB.
export const MAX_INDEX_BYTES = 2_000_000;

export type ImportStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
export type ImportFileStatus = "pending" | "stored" | "unchanged" | "failed";

export const ACTIVE_IMPORT: readonly ImportStatus[] = ["queued", "running", "paused"];

export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  queued: "Waiting for the agent",
  running: "Downloading",
  paused: "Paused between two slices",
  succeeded: "Done",
  failed: "Finished with errors",
  cancelled: "Cancelled",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type IndexSummary = { regulations: number; files: number; problems: string[] };

// What the person is about to import, before it is sent. Problems listed here are the obvious
// ones (not a list, entries without versions); the agent checks every field.
export function summarizeIndex(raw: unknown): IndexSummary {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { regulations: 0, files: 0, problems: ["The file is not a list of regulations."] };
  }
  const problems: string[] = [];
  let files = 0;
  raw.forEach((entry, i) => {
    const name = isRecord(entry) && typeof entry.regulation === "string" ? entry.regulation : `Entry ${i + 1}`;
    if (!isRecord(entry) || typeof entry.regulation !== "string") {
      problems.push(`${name} has no "regulation" name.`);
      return;
    }
    if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
      problems.push(`${name} has no versions.`);
      return;
    }
    for (const version of entry.versions) {
      if (isRecord(version) && Array.isArray(version.files)) files += version.files.length;
      else problems.push(`${name} has a version without files.`);
    }
  });
  return { regulations: raw.length, files, problems: problems.slice(0, 5) };
}

// The text of an uploaded file, as JSON. A sentence instead of the parser's message, which
// quotes the file and says "position 4711".
export function readIndexFile(text: string): Parsed<unknown> {
  if (new TextEncoder().encode(text).length > MAX_INDEX_BYTES) {
    return { ok: false, error: "The file is larger than 2 MB; an index is much smaller." };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
}

// Body of POST /api/regulations/imports: { organization_id, source_name, index }. The organisation
// comes from the page, like a new run's: the library the person was looking at when they pressed
// Import, even if another tab has switched since.
export function parseImportRequest(
  body: unknown,
): Parsed<{ organizationId: string; sourceName: string; index: unknown[] }> {
  if (!isRecord(body) || typeof body.source_name !== "string" || !Array.isArray(body.index)) {
    return {
      ok: false,
      error: 'Expected a JSON body like { "organization_id": "...", "source_name": "index.json", "index": [...] }.',
    };
  }
  if (!isUuid(body.organization_id)) return { ok: false, error: "Choose an organisation first." };
  // A browser sends only the file's name, but nothing stops a request from sending a path.
  const sourceName = body.source_name.split(/[\\/]/).pop()?.trim() ?? "";
  if (sourceName === "" || sourceName.length > 255) {
    return { ok: false, error: "The file needs a name of at most 255 characters." };
  }
  const summary = summarizeIndex(body.index);
  if (summary.problems.length > 0) return { ok: false, error: summary.problems.join(" ") };
  return { ok: true, value: { organizationId: body.organization_id, sourceName, index: body.index } };
}

export type FileCounts = Record<ImportFileStatus, number> & { total: number };

export function countFiles(statuses: readonly string[]): FileCounts {
  const counts: FileCounts = { pending: 0, stored: 0, unchanged: 0, failed: 0, total: statuses.length };
  for (const status of statuses) {
    if (status === "pending" || status === "stored" || status === "unchanged" || status === "failed") {
      counts[status] += 1;
    }
  }
  return counts;
}

// "92 files: 40 stored, 50 already there, 2 failed, 0 to go".
export function describeCounts(counts: FileCounts): string {
  if (counts.total === 0) return "Reading the file…";
  const parts = [`${counts.stored} stored`];
  if (counts.unchanged) parts.push(`${counts.unchanged} already in the library`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.pending) parts.push(`${counts.pending} to go`);
  return `${counts.total} files: ${parts.join(", ")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
