import assert from "node:assert/strict";
import { test } from "node:test";

import { basisOf, latestChecks, newestBasis, shortVersion, type StoredCheckRow } from "./run-checks.ts";

const LEVEL = { precision: 0.5, recall: 0.5, f1: 0.5, n_submitted: 2, n_expected: 2, n_matched: 1 };

function row(fields: Partial<StoredCheckRow> & { result?: Record<string, unknown> }): StoredCheckRow {
  return {
    run_id: "r1",
    source: "output",
    checked_at: "2026-10-24T22:00:00Z",
    agent_version: "abcdef1234567",
    certivity_commit: "2104a8e",
    ...fields,
    result: {
      kind: "main",
      case_id: "dev-rear-lamp",
      valid: true,
      items: 2,
      problems: [],
      requirement_estimate: { ...LEVEL, judge_rate: 0.83 },
      ...fields.result,
    },
  };
}

test("a run's output check wins over the one built from its stored rows", () => {
  const checks = latestChecks([
    row({ source: "output", result: { items: 400 } }),
    row({ source: "stored", result: { items: 120 } }),
  ]);
  assert.equal(checks.get("r1")?.source, "output");
  assert.equal(checks.get("r1")?.result.items, 400);
  assert.equal(latestChecks([row({ source: "stored" })]).get("r1")?.source, "stored");
});

test("a row that no longer parses is left out, not shown as zeros", () => {
  const broken = { ...row({}), result: { nonsense: true } };
  assert.equal(latestChecks([broken, row({ source: "other" })]).size, 0);
});

test("the judge rate is read from the stored estimate", () => {
  assert.equal(latestChecks([row({})]).get("r1")?.judgeRate, 0.83);
});

test("rows measured against another key or rate are told apart from the newest", () => {
  const checks = latestChecks([
    row({ run_id: "old", checked_at: "2026-10-24T20:00:00Z", result: { requirement_estimate: { ...LEVEL, judge_rate: 0.7 } } }),
    row({ run_id: "new", checked_at: "2026-10-24T23:00:00Z" }),
  ]);
  const newest = newestBasis(checks.values());
  assert.equal(newest, basisOf(checks.get("new")!));
  assert.notEqual(basisOf(checks.get("old")!), newest);
  assert.equal(newestBasis([]), null);
});

test("a version is shown as its short commit", () => {
  assert.equal(shortVersion("abcdef1234567"), "abcdef1");
  assert.equal(shortVersion(null), null);
});
