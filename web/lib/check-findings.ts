// What the check found on a run's requirements (agent domain/tools.py check_requirements, SYS-29):
// stored on each requirement as a `findings` array, and shown on the run page so a person sees
// the check worked and what it flagged. The trace shows the same tool result, but buried in JSON.

export type Finding = { by: string; problem: string; action: string };

export type FlaggedRequirement = {
  extId: string;
  status: string;
  regulation: string;
  version: string;
  page: number | null;
  paragraph: string;
  text: string;
  findings: Finding[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((f) => ({
    by: typeof f.by === "string" ? f.by : "",
    problem: typeof f.problem === "string" ? f.problem : "",
    action: typeof f.action === "string" ? f.action : "",
  }));
}

// Rejected first, then by id: the rejected ones are what left the file.
export function flagged(
  rows: {
    ext_id: string;
    status: string;
    regulation: string;
    version_label: string;
    page: number;
    paragraph: string | null;
    text: string;
    findings: unknown;
  }[],
): FlaggedRequirement[] {
  return rows
    .map((r) => ({
      extId: r.ext_id,
      status: r.status,
      regulation: r.regulation,
      version: r.version_label,
      page: r.page > 0 ? r.page : null,
      paragraph: r.paragraph ?? "",
      text: r.text,
      findings: parseFindings(r.findings),
    }))
    .filter((r) => r.findings.length > 0)
    .sort(
      (a, b) =>
        Number(b.status === "rejected") - Number(a.status === "rejected") ||
        a.extId.localeCompare(b.extId),
    );
}
