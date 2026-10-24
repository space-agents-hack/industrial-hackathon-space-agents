// The checks stored with each draft (table run_checks, #51), read for the part's comparison of its
// drafts. The agent writes them when a draft's file is checked; this side only reads.

import { type CheckResult, parseCheckResult } from "./certivity.ts";

export type StoredCheckRow = {
  run_id: string;
  source: string;
  checked_at: string;
  agent_version: string | null;
  certivity_commit: string;
  result: unknown;
};

export type StoredCheck = {
  source: "output" | "stored";
  checkedAt: string;
  agentVersion: string | null;
  certivityCommit: string;
  // The share of paragraph slots credited in the requirement estimate (REQUIREMENT_JUDGE_RATE in
  // the agent). Two drafts estimated with different rates are not comparable at that level.
  judgeRate: number | null;
  result: CheckResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function judgeRateOf(result: unknown): number | null {
  if (!isRecord(result) || !isRecord(result.requirement_estimate)) return null;
  const rate = result.requirement_estimate.judge_rate;
  return typeof rate === "number" ? rate : null;
}

// One check per run. The output's wins over the file built from stored rows: a run that later
// succeeded is judged by what it submitted. A row whose result no longer parses is left out
// rather than shown as zeros.
export function latestChecks(rows: readonly StoredCheckRow[]): Map<string, StoredCheck> {
  const byRun = new Map<string, StoredCheck>();
  for (const row of rows) {
    if (row.source !== "output" && row.source !== "stored") continue;
    const result = parseCheckResult(row.result);
    if (!result) continue;
    const found = byRun.get(row.run_id);
    if (found?.source === "output" && row.source === "stored") continue;
    byRun.set(row.run_id, {
      source: row.source,
      checkedAt: row.checked_at,
      agentVersion: row.agent_version,
      certivityCommit: row.certivity_commit,
      judgeRate: judgeRateOf(row.result),
      result,
    });
  }
  return byRun;
}

// What a check was measured against. Rows that differ from the newest check's basis are marked on
// the page: an answer key reloaded from another package, or a re-calibrated judge rate, moves the
// numbers without the draft changing, and the fix is to check them again.
export function basisOf(check: StoredCheck): string {
  return `${check.certivityCommit}|${check.judgeRate ?? ""}`;
}

export function newestBasis(checks: Iterable<StoredCheck>): string | null {
  let newest: StoredCheck | null = null;
  for (const check of checks) {
    if (!newest || Date.parse(check.checkedAt) > Date.parse(newest.checkedAt)) newest = check;
  }
  return newest ? basisOf(newest) : null;
}

// The short form of a commit, as GitHub and Vercel show it.
export function shortVersion(version: string | null): string | null {
  return version ? version.slice(0, 7) : null;
}
