// The sub-goal page: which requirements derived from one version of a regulation change in another
// (agent/agent_service/domain/changes.py). The agent builds the file; this side checks the request
// before it is sent and reads the answer. Validity is not decided here either: the page sends the
// file through /api/checks, Certivity's own validate.py, like any other file.

import { type Parsed, isUuid } from "./validation.ts";

// Certivity's schema allows 5,000 changes, and the agent takes at most as many requirements in.
export const MAX_REQUIREMENTS = 5000;
// A requirements_old.json of 5,000 entries is about 2 MB; Vercel refuses bodies over 4.5 MB.
export const MAX_REQUIREMENTS_BYTES = 4_000_000;

export type ChangeKind = "modified" | "removed" | "added";

export type Change = {
  change: ChangeKind;
  requirementId: string | null;
  newText: string | null;
  reason: string;
  page: number | null;
  paragraph: string | null;
};

export type ChangesResult = {
  // Exactly what the agent produced, for checking and download.
  submission: unknown;
  changes: Change[];
  counts: Record<ChangeKind, number>;
  requirements: number;
  regulation: string;
  oldVersion: string;
  newVersion: string;
};

export type OldRequirement = { id: string; text: string; source?: Record<string, unknown> };

export type ChangesRequest = {
  organizationId: string;
  oldVersionId: string;
  newVersionId: string;
  caseId: string;
  teamId: string;
  // null: the requirements Certivity ships for caseId, loaded in the database.
  requirementsOld: OldRequirement[] | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Ids as Certivity's format writes them (team-07, subgoal-dev, subgoal-heldout).
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// An uploaded requirements file, in Certivity's requirements_old.json format: a list of
// { id, text, source }. Only what the diff reads is checked; extra fields pass through.
export function readRequirementsFile(text: string): Parsed<OldRequirement[]> {
  if (new TextEncoder().encode(text).length > MAX_REQUIREMENTS_BYTES) {
    return { ok: false, error: "The file is larger than 4 MB." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
  return parseRequirements(raw);
}

function parseRequirements(raw: unknown): Parsed<OldRequirement[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'Expected a list of requirements like [{ "id": "R-001", "text": "…" }].' };
  }
  if (raw.length > MAX_REQUIREMENTS) return { ok: false, error: `At most ${MAX_REQUIREMENTS} requirements.` };
  const ids = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "" || typeof item.text !== "string") {
      return { ok: false, error: `Requirement ${i + 1} needs an "id" and a "text".` };
    }
    if (ids.has(item.id)) return { ok: false, error: `The id ${item.id} appears twice.` };
    ids.add(item.id);
    if (item.source !== undefined && !isRecord(item.source)) {
      return { ok: false, error: `Requirement ${item.id}: "source" must be an object.` };
    }
  }
  return { ok: true, value: raw as OldRequirement[] };
}

// Body of POST /api/changes.
export function parseChangesRequest(body: unknown): Parsed<ChangesRequest> {
  if (!isRecord(body)) return { ok: false, error: "Expected a JSON body." };
  if (!isUuid(body.organization_id)) return { ok: false, error: "Choose an organisation first." };
  if (!isUuid(body.old_version_id) || !isUuid(body.new_version_id)) {
    return { ok: false, error: "Choose the old and the new version." };
  }
  if (body.old_version_id === body.new_version_id) return { ok: false, error: "Choose two different versions." };
  const caseId = typeof body.case_id === "string" ? body.case_id.trim() : "";
  const teamId = typeof body.team_id === "string" ? body.team_id.trim() : "";
  if (!ID.test(caseId)) return { ok: false, error: "The case id is letters, digits, dots, dashes and underscores." };
  if (!ID.test(teamId)) return { ok: false, error: "Give your team id as the platform shows it (e.g. team-07)." };
  let requirementsOld: OldRequirement[] | null = null;
  if (body.requirements_old !== undefined && body.requirements_old !== null) {
    const parsed = parseRequirements(body.requirements_old);
    if (!parsed.ok) return parsed;
    requirementsOld = parsed.value;
  }
  return {
    ok: true,
    value: {
      organizationId: body.organization_id,
      oldVersionId: body.old_version_id,
      newVersionId: body.new_version_id,
      caseId,
      teamId,
      requirementsOld,
    },
  };
}

function parseChange(value: unknown): Change | null {
  if (!isRecord(value)) return null;
  const kind = value.change;
  if (kind !== "modified" && kind !== "removed" && kind !== "added") return null;
  if (typeof value.reason !== "string") return null;
  const source = isRecord(value.source) ? value.source : {};
  return {
    change: kind,
    requirementId: typeof value.requirement_id === "string" ? value.requirement_id : null,
    newText: typeof value.new_text === "string" ? value.new_text : null,
    reason: value.reason,
    page: typeof source.page === "number" ? source.page : null,
    paragraph: typeof source.paragraph === "string" ? source.paragraph : null,
  };
}

// null when the body is not the agent's answer: an older agent, or an error page in between.
export function parseChangesResult(body: unknown): ChangesResult | null {
  if (!isRecord(body) || !isRecord(body.submission) || !isRecord(body.counts)) return null;
  const raw = body.submission.changes;
  if (!Array.isArray(raw)) return null;
  const changes = raw.map(parseChange);
  if (changes.some((c) => c === null)) return null;
  const counts = body.counts;
  const count = (key: ChangeKind): number => {
    const n = counts[key];
    return typeof n === "number" ? n : 0;
  };
  return {
    submission: body.submission,
    changes: changes as Change[],
    counts: { modified: count("modified"), removed: count("removed"), added: count("added") },
    requirements: typeof body.requirements === "number" ? body.requirements : 0,
    regulation: typeof body.regulation === "string" ? body.regulation : "",
    oldVersion: typeof body.old_version === "string" ? body.old_version : "",
    newVersion: typeof body.new_version === "string" ? body.new_version : "",
  };
}

// A sub-goal case whose requirements are loaded, with the regulation they cite most.
export type SubgoalCase = { caseId: string; regulation: string | null };

export function parseSubgoalCases(body: unknown): SubgoalCase[] | null {
  if (!isRecord(body) || !Array.isArray(body.cases)) return null;
  return body.cases.flatMap((c) =>
    isRecord(c) && typeof c.case_id === "string"
      ? [{ caseId: c.case_id, regulation: typeof c.regulation === "string" ? c.regulation : null }]
      : [],
  );
}

// The regulation an uploaded list cites most, to preselect it.
export function citedRegulation(requirements: readonly OldRequirement[]): string | null {
  const counts = new Map<string, number>();
  for (const r of requirements) {
    const code = r.source?.regulation;
    if (typeof code === "string") counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [code, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = code;
  return best;
}

export type VersionOption = { id: string; label: string; role: string | null };

// Base to latest, which is the sub-goal's question; otherwise the two newest, older first.
export function defaultPair(versions: readonly VersionOption[]): [string, string] | null {
  if (versions.length < 2) return null;
  const sorted = [...versions].sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
  const base = versions.find((v) => v.role === "base");
  const latest = versions.find((v) => v.role === "latest");
  if (base && latest && base.id !== latest.id) return [base.id, latest.id];
  const [older, newer] = sorted.slice(-2);
  return [older.id, newer.id];
}

// "4 modified, 1 removed, 17 added".
export function describeCounts(counts: Record<ChangeKind, number>): string {
  return `${counts.modified} modified, ${counts.removed} removed, ${counts.added} added`;
}
