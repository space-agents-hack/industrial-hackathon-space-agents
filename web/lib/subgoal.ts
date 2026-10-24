// Sub-goal cases (#42, IF-1): a case whose files are one of Certivity's subgoal/<folder> folders
// (requirements_old.json, files.json, and optionally old.pdf and new.pdf), and whose run writes
// the changes file instead of the requirements file. It is a `cases` row like any other, told apart
// by cases.kind (supabase/migrations/20261024350000_case_kind.sql). Pure, so node --test runs it.

import { formatOf, refusal } from "./case-files.ts";

export type CaseKind = "main" | "subgoal";

// The column only allows these two. Anything else is read as 'main', the column's own default, so
// a row from before the column (or a select that forgot it) lands on the main goal's pages, which
// is where every case lived until then.
export function caseKind(value: unknown): CaseKind {
  return value === "subgoal" ? "subgoal" : "main";
}

// The main goal's pages list only main cases and Changes only sub-goal ones: a sub-goal case under
// Cases would invite adding a specification to it, and its run would then ignore that file.
export function ofKind<T extends { kind: string }>(cases: readonly T[], kind: CaseKind): T[] {
  return cases.filter((c) => caseKind(c.kind) === kind);
}

// What a sub-goal folder holds. The agent reads nothing else for this kind of case, so anything else
// is refused before it is uploaded rather than listed as "failed" after.
export const SUBGOAL_ACCEPT = ".json,.pdf";

export function subgoalRefusal(file: { name: string; size: number }): string | null {
  const format = formatOf(file.name);
  if (format !== "json" && format !== "pdf") {
    return `${file.name}: a review takes only .json and .pdf files (requirements_old.json, files.json, old.pdf, new.pdf).`;
  }
  return refusal(file);
}

// Certivity's expected.json for a sub-goal case is an object with a `changes` list; the inputs are
// lists (requirements_old.json, files.json). Decided by the content and not the name, because a
// renamed copy gives the answers away just the same, and a run that reads the answer key scores
// well here and teaches nothing for the held-out case (SYS-42). A previous run's own output has the
// same shape and is not an input either.
export function isAnswerKey(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as { changes?: unknown }).changes)
  );
}

export function answerKeyMessage(filename: string): string {
  return `${filename} is Certivity's answer key. It is not added to the review, so the run can never read it; the checks already have it from Certivity's package.`;
}

// .DS_Store, ._old.pdf (macOS) and folders like .git come with a dropped folder and are never part
// of Certivity's package. Skipped without a word: listing them as refused would bury the one
// message that matters.
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

type Screenable = { name: string; size: number; webkitRelativePath?: string; text(): Promise<string> };

export type Screened<T> = { keep: T[]; problems: string[]; answerKeys: string[] };

// What goes up from a pick or a drop: hidden files dropped, other formats refused with the reason,
// and answer keys held back with their own message. Only .json files are read, and only to decide.
export async function screenSubgoalFiles<T extends Screenable>(files: readonly T[]): Promise<Screened<T>> {
  const result: Screened<T> = { keep: [], problems: [], answerKeys: [] };
  for (const file of files) {
    if (isHiddenPath(file.webkitRelativePath || file.name)) continue;
    const reason = subgoalRefusal(file);
    if (reason) {
      result.problems.push(reason);
      continue;
    }
    if (formatOf(file.name) === "json" && isAnswerKey(await file.text().catch(() => ""))) {
      result.answerKeys.push(answerKeyMessage(file.name));
      continue;
    }
    result.keep.push(file);
  }
  return result;
}

// The parts of the browser's FileSystemEntry that a dropped folder is walked with
// (DataTransferItem.webkitGetAsEntry). Structural, so the walk can be tested without a browser.
export type EntryLike = {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
  // FileSystemFileEntry.
  file?(success: (file: File) => void, failure?: (error: unknown) => void): void;
  // FileSystemDirectoryEntry.
  createReader?(): DirectoryReaderLike;
};

export type DirectoryReaderLike = {
  readEntries(success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void): void;
};

// readEntries hands a directory over in batches (Chrome: at most 100 per call) and ends with an
// empty one; reading it once silently loses the rest of a large folder.
async function readAll(reader: DirectoryReaderLike): Promise<EntryLike[]> {
  const all: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

// Every file under the dropped entries, folders walked to the bottom, hidden ones left out.
export async function filesInEntries(entries: readonly EntryLike[]): Promise<File[]> {
  const files: File[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile && entry.file) {
      const read = entry.file.bind(entry);
      files.push(await new Promise<File>((resolve, reject) => read(resolve, reject)));
    } else if (entry.isDirectory && entry.createReader) {
      files.push(...(await filesInEntries(await readAll(entry.createReader()))));
    }
  }
  return files;
}
