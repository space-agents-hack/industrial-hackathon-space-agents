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

export type CheckResult = {
  kind: "main" | "subgoal" | null;
  caseId: string | null;
  valid: boolean;
  items: number | null;
  problems: { path: string; message: string }[];
  problemCount: number;
  jsonSpan: [number, number] | null;
  score: { regulation: Level; page: Level } | null;
  notes: string[];
  certivityCommit: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLevel(value: unknown): Level | null {
  if (!isRecord(value)) return null;
  const keys = ["precision", "recall", "f1", "n_submitted", "n_expected", "n_matched"] as const;
  if (!keys.every((key) => typeof value[key] === "number")) return null;
  return value as Level;
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
    notes: Array.isArray(body.notes) ? body.notes.filter((n): n is string => typeof n === "string") : [],
    certivityCommit: typeof body.certivity_commit === "string" ? body.certivity_commit : "unknown",
  };
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
