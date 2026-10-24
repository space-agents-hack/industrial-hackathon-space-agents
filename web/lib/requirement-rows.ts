// The requirements of a main-goal submission, as rows to read on the run page. Read-only: the file
// itself (IF-4) is what Copy and Download give and what is uploaded; this never changes it.
//
// The schema (agent/certivity/schemas/submission_main.schema.json) nests the citation under
// `source`. A file that puts the same fields on the requirement itself is still shown, so a person
// can read what a run produced even when it would fail the schema; the checks say so separately.

export type RequirementRow = {
  id: string;
  text: string;
  regulation: string;
  version: string;
  page: number | null;
  paragraph: string;
};

export type RegulationCount = { regulation: string; count: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

// Null when the output is not JSON or has no requirements list (prose, a sub-goal changes file).
export function requirementRows(output: string): RequirementRow[] | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.requirements)) return null;
  return value.requirements.filter(isRecord).map((r) => {
    const source = isRecord(r.source) ? r.source : r;
    const page = Number(source.page);
    return {
      id: str(r.id),
      text: str(r.text),
      regulation: str(source.regulation),
      version: str(source.version),
      page: Number.isInteger(page) && page > 0 ? page : null,
      paragraph: str(source.paragraph),
    };
  });
}

// How many requirements each regulation gave, most first, then by code in numeric order ("UN R7"
// before "UN R48").
export function countByRegulation(rows: RequirementRow[]): RegulationCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.regulation, (counts.get(row.regulation) ?? 0) + 1);
  return [...counts]
    .map(([regulation, count]) => ({ regulation, count }))
    .sort((a, b) => b.count - a.count || a.regulation.localeCompare(b.regulation, "en", { numeric: true }));
}
