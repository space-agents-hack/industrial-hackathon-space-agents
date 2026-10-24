import assert from "node:assert/strict";
import { test } from "node:test";

import { downloadName, looksLikeSubmission, parseCheckResult, submissionPart } from "./certivity.ts";

const LEVEL = { precision: 1, recall: 0.5, f1: 0.667, n_submitted: 2, n_expected: 4, n_matched: 2 };

const AGENT_ANSWER = {
  kind: "main",
  case_id: "dev-rear-lamp",
  valid: false,
  items: 2,
  problems: [{ path: "$.requirements[1].id", message: "Duplicate id 'R-1'." }],
  problem_count: 1,
  json_span: [5, 12],
  score: { regulation_level: LEVEL, page_level: LEVEL },
  notes: ["Regulation and page level only."],
  certivity_commit: "2104a8e",
};

test("parseCheckResult reads the agent's answer", () => {
  const result = parseCheckResult(AGENT_ANSWER);
  assert.ok(result);
  assert.equal(result.caseId, "dev-rear-lamp");
  assert.equal(result.problems.length, 1);
  assert.deepEqual(result.jsonSpan, [5, 12]);
  assert.equal(result.score?.page.n_expected, 4);
});

test("the per-regulation breakdown is read, and a malformed row dropped", () => {
  const row = {
    regulation: "UN R148",
    requirements: 0,
    expected_requirements: 12,
    pages: 0,
    pages_correct: 0,
    expected_pages: 5,
    expected_pages_found: 0,
  };
  const result = parseCheckResult({ ...AGENT_ANSWER, breakdown: [row, { regulation: "UN R48" }] });
  assert.deepEqual(result?.breakdown, [row]);
  assert.deepEqual(parseCheckResult(AGENT_ANSWER)?.breakdown, []);
});

test("parsing an already parsed result loses the case, the commit and the score", () => {
  // What production showed on 2026-10-24 when /api/checks returned the parsed result and the
  // browser parsed it again. The route must hand the browser the agent's own body.
  const twice = parseCheckResult(JSON.parse(JSON.stringify(parseCheckResult(AGENT_ANSWER))));
  assert.ok(twice);
  assert.equal(twice.caseId, null);
  assert.equal(twice.score, null);
  assert.equal(twice.certivityCommit, "unknown");
});

test("parseCheckResult refuses what is not a check result", () => {
  assert.equal(parseCheckResult(null), null);
  assert.equal(parseCheckResult({ detail: "Not found" }), null);
});

test("a malformed score is dropped, not shown half", () => {
  const result = parseCheckResult({ ...AGENT_ANSWER, score: { regulation_level: LEVEL } });
  assert.equal(result?.score, null);
});

test("looksLikeSubmission spots main-goal and sub-goal files, not prose", () => {
  assert.ok(looksLikeSubmission('{"team_id": "t", "requirements": []}'));
  assert.ok(looksLikeSubmission('Here:\n```json\n{"changes": []}\n```'));
  assert.equal(looksLikeSubmission("The lamp needs UN R48 requirements."), false);
  assert.equal(looksLikeSubmission(null), false);
});

test("submissionPart cuts exactly the JSON out of the answer", () => {
  const text = 'Here: {"a":1} done';
  const result = parseCheckResult({ ...AGENT_ANSWER, json_span: [6, 13] });
  assert.ok(result);
  assert.equal(submissionPart(text, result), '{"a":1}');
});

test("submissionPart counts characters as Python does, past the BMP too", () => {
  // "🚗" is one character for Python and two UTF-16 units for JavaScript.
  const text = '🚗 {"a":1}';
  const result = parseCheckResult({ ...AGENT_ANSWER, json_span: [2, 9] });
  assert.ok(result);
  assert.equal(submissionPart(text, result), '{"a":1}');
});

test("downloadName is a safe file name from the case id", () => {
  const result = parseCheckResult({ ...AGENT_ANSWER, case_id: "dev rear/lamp" });
  assert.ok(result);
  assert.equal(downloadName(result), "dev-rear-lamp.json");
});
