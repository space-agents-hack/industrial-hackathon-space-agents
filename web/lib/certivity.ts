// What the agent's POST /checks returns: Certivity's validate.py and score_local.py on one
// submission (agent/agent_service/domain/certivity.py). The web only shows it; it never decides
// validity itself, because the platform runs Certivity's Python, not anything written here.

// Certivity's own limit (validate.py MAX_BYTES). Vercel refuses request bodies over 4.5 MB before
// the route runs, so a file between 4.5 and 5 MB cannot be checked here; validate it locally.
export const SUBMISSION_MAX_BYTES = 5 * 1024 * 1024;

export type Level = {
  precision: number;
  recall: number;
  f1: number;
  n_submitted: number;
  n_expected: number;
  n_matched: number;
};

// The score split by regulation (certivity.breakdown in the agent), to see which regulation was
// missed or extra. Only where there is a score, so only for a case with an answer key.
export type RegulationRow = {
  regulation: string;
  requirements: number;
  expected_requirements: number;
  pages: number;
  pages_correct: number;
  expected_pages: number;
  expected_pages_found: number;
};

// A sub-goal file against the sub-goal's expected.json (regdiff.score in the agent): Certivity ships
// that answer but no scorer, so this is a rules-based approximation of the platform's score.
export type Counted = { submitted: number; expected: number; matched: number; precision: number; recall: number };

export type SubgoalScore = {
  flagged: Counted;
  changeType: { right: number; of: number; accuracy: number };
  added: Counted;
  missed: string[];
  extra: string[];
  wrongType: string[];
};

export type CheckResult = {
  kind: "main" | "subgoal" | null;
  caseId: string | null;
  valid: boolean;
  items: number | null;
  problems: { path: string; message: string }[];
  problemCount: number;
  jsonSpan: [number, number] | null;
  score: { regulation: Level; page: Level } | null;
  breakdown: RegulationRow[];
  // The requirement level estimated by counting (certivity.requirement_estimate in the agent): the
  // platform judges it with a model, so this is a bound times a measured rate, not a judgement.
  requirementEstimate: Level | null;
  subgoalScore: SubgoalScore | null;
  notes: string[];
  certivityCommit: string;
  // Which of a run's files this result was stored with (run_checks, #51), or null when it was not
  // stored: a pasted file, a chosen answer key, or text that is not the run's file.
  savedAs: "output" | "stored" | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROW_COUNTS = [
  "requirements",
  "expected_requirements",
  "pages",
  "pages_correct",
  "expected_pages",
  "expected_pages_found",
] as const;

function parseRow(value: unknown): RegulationRow | null {
  if (!isRecord(value) || typeof value.regulation !== "string") return null;
  if (!ROW_COUNTS.every((key) => typeof value[key] === "number")) return null;
  return value as RegulationRow;
}

function parseLevel(value: unknown): Level | null {
  if (!isRecord(value)) return null;
  const keys = ["precision", "recall", "f1", "n_submitted", "n_expected", "n_matched"] as const;
  if (!keys.every((key) => typeof value[key] === "number")) return null;
  return value as Level;
}

function parseCounted(value: unknown): Counted | null {
  if (!isRecord(value)) return null;
  const keys = ["submitted", "expected", "matched", "precision", "recall"] as const;
  return keys.every((key) => typeof value[key] === "number") ? (value as Counted) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parseSubgoalScore(value: unknown): SubgoalScore | null {
  if (!isRecord(value)) return null;
  const flagged = parseCounted(value.flagged);
  const added = parseCounted(value.added);
  const type = value.change_type;
  if (!flagged || !added || !isRecord(type)) return null;
  if (typeof type.right !== "number" || typeof type.of !== "number" || typeof type.accuracy !== "number") return null;
  return {
    flagged,
    changeType: { right: type.right, of: type.of, accuracy: type.accuracy },
    added,
    missed: strings(value.missed),
    extra: strings(value.extra),
    wrongType: strings(value.wrong_type),
  };
}

// null when the body is not a check result: an older agent, or an error page in between.
export function parseCheckResult(body: unknown): CheckResult | null {
  if (!isRecord(body) || typeof body.valid !== "boolean" || !Array.isArray(body.problems)) return null;
  const kind = body.kind === "main" || body.kind === "subgoal" ? body.kind : null;
  const span =
    Array.isArray(body.json_span) && body.json_span.length === 2 && body.json_span.every(Number.isInteger)
      ? (body.json_span as [number, number])
      : null;
  let score: CheckResult["score"] = null;
  if (isRecord(body.score)) {
    const regulation = parseLevel(body.score.regulation_level);
    const page = parseLevel(body.score.page_level);
    if (regulation && page) score = { regulation, page };
  }
  return {
    kind,
    caseId: typeof body.case_id === "string" ? body.case_id : null,
    valid: body.valid,
    items: typeof body.items === "number" ? body.items : null,
    problems: body.problems.filter(
      (p): p is { path: string; message: string } =>
        isRecord(p) && typeof p.path === "string" && typeof p.message === "string",
    ),
    problemCount: typeof body.problem_count === "number" ? body.problem_count : body.problems.length,
    jsonSpan: span,
    score,
    // An older agent sends none; a malformed row is dropped rather than shown half.
    breakdown: Array.isArray(body.breakdown)
      ? body.breakdown.map(parseRow).filter((r): r is RegulationRow => r !== null)
      : [],
    // An older agent sends none; a malformed one is dropped like a malformed main score.
    requirementEstimate: parseLevel(body.requirement_estimate),
    subgoalScore: parseSubgoalScore(body.subgoal_score),
    notes: Array.isArray(body.notes) ? body.notes.filter((n): n is string => typeof n === "string") : [],
    certivityCommit: typeof body.certivity_commit === "string" ? body.certivity_commit : "unknown",
    savedAs: body.saved_as === "output" || body.saved_as === "stored" ? body.saved_as : null,
  };
}

// A main-goal expected.json has a requirements list, a sub-goal one a changes list. The agent sets
// aside a file of the other format than the submission, with a note.
export function isExpectedFile(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Array.isArray(value.requirements) || Array.isArray(value.changes));
}

// Whether a run's output is worth checking. Loose on purpose: the agent finds the JSON even inside
// a sentence or a code fence, and a false positive only costs one call that says "not JSON".
export function looksLikeSubmission(text: string | null): text is string {
  return text !== null && text.includes("{") && /"(requirements|changes)"\s*:/.test(text);
}

// Exactly the JSON the agent found, which is what has to be uploaded. The span counts UTF-16 code
// units on this side and code points on the Python side; they differ only past the Basic
// Multilingual Plane (emoji, some symbols), so the slice is checked to parse before it is used.
export function submissionPart(text: string, result: CheckResult): string {
  if (!result.jsonSpan) return text;
  const [begin, end] = result.jsonSpan;
  const part = Array.from(text).slice(begin, end).join("");
  try {
    JSON.parse(part);
    return part;
  } catch {
    return text;
  }
}

export function downloadName(result: CheckResult): string {
  const safe = (result.caseId ?? "submission").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe}.json`;
}

export function formatRatio(value: number): string {
  return value.toFixed(3);
}

// F-beta with beta 2, the measure the leaderboard uses at the requirement level ("Req F2"): recall
// weighs four times precision. score_local.py gives P and R only for regulations and pages, so
// this is F2 at those levels, and at the requirement level only of the count estimate: the real one
// is computed on the platform.
export function f2(level: Pick<Level, "precision" | "recall">): number {
  const { precision: p, recall: r } = level;
  return p + r === 0 ? 0 : (5 * p * r) / (4 * p + r);
}
