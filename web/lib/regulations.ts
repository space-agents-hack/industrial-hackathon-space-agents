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
  running: "Downloading and splitting into paragraphs",
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

// What the import does after the files are stored (#52): split each version into paragraphs with the
// agent's current reader, and have the vision model read the pictures of each split version.
export type ImportSteps = {
  // Versions split by the current reader (a PDF that cannot be split counts: it is recorded with
  // that reader). Null when the agent did not say which reader is current.
  split: { done: number; total: number } | null;
  // Distinct pictures found in the split versions, and how many the model has read or refused.
  // Pictures of versions not split yet are not known until they are.
  pictures: { read: number; total: number; model: string | null };
};

// Whether the latest import needs no attention: every file handled without a failure, every
// version split by the current reader and every picture found read. Then its card shrinks to one
// green line (Ramón, 2026-10-25); anything short of that keeps the bars, which say what is left.
export function importComplete(latest: { status: ImportStatus; counts: FileCounts; steps: ImportSteps }): boolean {
  const { split, pictures } = latest.steps;
  return (
    latest.status === "succeeded" &&
    latest.counts.failed === 0 &&
    latest.counts.pending === 0 &&
    (split === null || split.done >= split.total) &&
    pictures.read >= pictures.total
  );
}

export function countSplit(
  versions: readonly { extracted_with: string | null }[],
  extractor: string | null,
): ImportSteps["split"] {
  if (!extractor) return null;
  return { done: versions.filter((v) => v.extracted_with === extractor).length, total: versions.length };
}

export function countPictures(
  placed: readonly string[],
  described: ReadonlySet<string>,
): { read: number; total: number } {
  const distinct = new Set(placed);
  let read = 0;
  for (const sha of distinct) if (described.has(sha)) read += 1;
  return { read, total: distinct.size };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

// ---------------------------------------------------------------------------------------------
// Deleting regulations (SYS-46, #56)
// ---------------------------------------------------------------------------------------------

// What delete_regulations accepts in one call (migration 20261024380000): the paragraphs of 25
// regulations go well inside the API's statement timeout. Clearing a library is that many calls.
export const DELETE_BATCH = 25;

export type DeleteTarget = { ids: string[] } | { all: true; confirm: string };

// Body of DELETE /api/regulations: { organization_id, regulation_ids } for chosen regulations, or
// { organization_id, all: true, confirm } to clear the whole library, where `confirm` is the
// organisation's name as the person typed it. The route checks that name again: a hidden field or
// a replayed request must not empty a library nobody meant to.
export function parseDeleteRequest(body: unknown): Parsed<{ organizationId: string; target: DeleteTarget }> {
  if (!isRecord(body)) {
    return { ok: false, error: 'Expected a JSON body like { "organization_id": "...", "regulation_ids": ["..."] }.' };
  }
  if (!isUuid(body.organization_id)) return { ok: false, error: "Choose an organisation first." };
  if (body.all === true) {
    if (typeof body.confirm !== "string") return { ok: false, error: "Type the organisation's name to clear its library." };
    return { ok: true, value: { organizationId: body.organization_id, target: { all: true, confirm: body.confirm } } };
  }
  const ids = body.regulation_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isUuid)) {
    return { ok: false, error: "Choose at least one regulation to delete." };
  }
  // One page of the library at most; clearing all of it is `all`.
  if (ids.length > 1000) return { ok: false, error: "Delete at most 1000 regulations at a time." };
  return { ok: true, value: { organizationId: body.organization_id, target: { ids: [...new Set(ids)] } } };
}

// The organisation's name, typed. Case and surrounding spaces do not count: the point is that the
// person read which library this is, and "org one" for "Org One" shows they did.
export function confirmsClear(typed: string, organizationName: string): boolean {
  return typed.trim() !== "" && typed.trim().toLowerCase() === organizationName.trim().toLowerCase();
}

export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type DeleteOutcome = {
  regulations: number;
  versions: number;
  paragraphs: number;
  requirementsUnlinked: number;
  paths: string[];
};

export const NO_DELETION: DeleteOutcome = { regulations: 0, versions: 0, paragraphs: 0, requirementsUnlinked: 0, paths: [] };

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

// delete_regulations' answer, added to what earlier batches deleted.
export function addOutcome(total: DeleteOutcome, raw: unknown): DeleteOutcome {
  const o = isRecord(raw) ? raw : {};
  const paths = Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === "string") : [];
  return {
    regulations: total.regulations + count(o.regulations),
    versions: total.versions + count(o.versions),
    paragraphs: total.paragraphs + count(o.paragraphs),
    requirementsUnlinked: total.requirementsUnlinked + count(o.requirements_unlinked),
    paths: [...total.paths, ...paths],
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export type LibraryPart = { regulations: number; versions: number; paragraphs: number; requirements: number };

// The confirmation's sentences, the same for one regulation and for the whole library, so the two
// dialogs cannot drift apart on what is kept.
export function describeConsequences(part: LibraryPart): { removed: string; kept: string } {
  const one = part.regulations === 1;
  const removed =
    `Removed for every project of the organisation: ${plural(part.regulations, "regulation")}, ` +
    `${plural(part.versions, "version")} and their PDFs, ${plural(part.paragraphs, "paragraph")}, ` +
    `their scope summaries and search index, and the projects' choice of ${one ? "it" : "them"}.`;
  const n = part.requirements;
  const kept =
    n === 0
      ? `No requirement cites ${one ? "it" : "them"}. The import history stays, and so do the embedding ` +
        "vectors, so importing the same files again costs no new embeddings."
      : `${plural(n, "requirement")} already written ${n === 1 ? "cites" : "cite"} ${one ? "it" : "them"}. ` +
        `${n === 1 ? "It stays with its run" : "They stay with their runs"}, citation text included, but ` +
        `${n === 1 ? "loses" : "lose"} the link to the paragraph; importing again does not restore it. ` +
        "The import history and the embedding vectors stay.";
  return { removed, kept };
}

export function describeDeletion(outcome: DeleteOutcome): string {
  if (outcome.regulations === 0) return "Nothing to delete: the library is already empty.";
  const unlinked =
    outcome.requirementsUnlinked > 0
      ? ` ${plural(outcome.requirementsUnlinked, "requirement")} kept ${outcome.requirementsUnlinked === 1 ? "its" : "their"} citation without the link.`
      : "";
  return (
    `Deleted ${plural(outcome.regulations, "regulation")}: ${plural(outcome.versions, "version")}, ` +
    `${plural(outcome.paragraphs, "paragraph")}.${unlinked}`
  );
}
