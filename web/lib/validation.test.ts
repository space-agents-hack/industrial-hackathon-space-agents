import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NOTE_MAX_LENGTH,
  TASK_MAX_LENGTH,
  isUuid,
  parseDecision,
  parseNewRun,
  readJson,
} from "./validation.ts";

test("isUuid accepts a uuid and rejects everything else", () => {
  assert.equal(isUuid("3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b"), true);
  assert.equal(isUuid("3F2B8C1E-9A4D-4E6F-8B7A-1C2D3E4F5A6B"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid("3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b; drop table runs"), false);
  assert.equal(isUuid(42), false);
});

const ORG = "3941c1f6-f67c-455e-b12b-92c9f7d2d944";

test("parseNewRun trims the task and enforces the database limits", () => {
  assert.deepEqual(parseNewRun({ task: "  Triage ECN-1001  ", organization_id: ORG }), {
    ok: true,
    value: { task: "Triage ECN-1001", organizationId: ORG, files: [], caseId: null, model: null },
  });
  assert.equal(parseNewRun({ task: "   ", organization_id: ORG }).ok, false);
  assert.equal(parseNewRun({ task: 5, organization_id: ORG }).ok, false);
  assert.equal(parseNewRun(null).ok, false);
  assert.equal(parseNewRun(["task"]).ok, false);
  assert.equal(parseNewRun({ task: "x".repeat(TASK_MAX_LENGTH), organization_id: ORG }).ok, true);
  assert.equal(parseNewRun({ task: "x".repeat(TASK_MAX_LENGTH + 1), organization_id: ORG }).ok, false);
});

test("parseNewRun needs the organisation the run belongs to", () => {
  assert.equal(parseNewRun({ task: "Triage ECN-1001" }).ok, false);
  assert.equal(parseNewRun({ task: "Triage ECN-1001", organization_id: "Default" }).ok, false);
});

test("parseNewRun counts characters, not UTF-16 units, as Postgres does", () => {
  const astral = "\u{1F527}";
  assert.equal(astral.length, 2);
  assert.equal(parseNewRun({ task: astral.repeat(TASK_MAX_LENGTH), organization_id: ORG }).ok, true);
});

test("parseDecision accepts the two decisions and normalises the note", () => {
  assert.deepEqual(parseDecision({ decision: "approved" }), {
    ok: true,
    value: { decision: "approved", note: null },
  });
  assert.deepEqual(parseDecision({ decision: "denied", note: "  wrong part  " }), {
    ok: true,
    value: { decision: "denied", note: "wrong part" },
  });
  assert.deepEqual(parseDecision({ decision: "approved", note: "   " }), {
    ok: true,
    value: { decision: "approved", note: null },
  });
  assert.deepEqual(parseDecision({ decision: "approved", note: null }), {
    ok: true,
    value: { decision: "approved", note: null },
  });
});

test("parseDecision rejects anything else", () => {
  assert.equal(parseDecision({ decision: "pending" }).ok, false);
  assert.equal(parseDecision({ decision: "approved", note: 7 }).ok, false);
  assert.equal(parseDecision({ decision: "approved", note: "x".repeat(NOTE_MAX_LENGTH + 1) }).ok, false);
  assert.equal(parseDecision(undefined).ok, false);
});

test("readJson returns undefined for a body that is not JSON", async () => {
  const bad = new Request("http://localhost/api/runs", { method: "POST", body: "{nope" });
  assert.equal(await readJson(bad), undefined);
  const good = new Request("http://localhost/api/runs", { method: "POST", body: '{"task":"a"}' });
  assert.deepEqual(await readJson(good), { task: "a" });
});

const FILE = {
  storage_path: `${ORG}/9c5e7a0e-1111-4222-8333-444455556666/1-spec.md`,
  filename: "spec.md",
  format: "md",
  media_type: "text/markdown",
  bytes: 1299,
  sha256: "a".repeat(64),
};

test("parseNewRun names a run started from files alone after its files", () => {
  const parsed = parseNewRun({ task: " ", organization_id: ORG, files: [FILE] });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.value.task, "Case files: spec.md");
  assert.equal(parsed.value.files[0].format, "md");
});

test("parseNewRun refuses a file from another organisation, an unknown format or a bad size", () => {
  const other = "11111111-2222-4333-8444-555566667777";
  assert.equal(parseNewRun({ task: "x", organization_id: ORG, files: [{ ...FILE, storage_path: `${other}/u/1-spec.md` }] }).ok, false);
  assert.equal(parseNewRun({ task: "x", organization_id: ORG, files: [{ ...FILE, filename: "notes.doc", format: "doc" }] }).ok, false);
  assert.equal(parseNewRun({ task: "x", organization_id: ORG, files: [{ ...FILE, bytes: 0 }] }).ok, false);
  assert.equal(parseNewRun({ task: "x", organization_id: ORG, files: "spec.md" }).ok, false);
  assert.equal(parseNewRun({ task: "x", organization_id: ORG, files: Array(21).fill(FILE) }).ok, false);
});

test("parseNewRun takes a case instead of files, with an optional task", () => {
  const caseId = "22222222-3333-4444-8555-666677778888";
  assert.deepEqual(parseNewRun({ task: " ", organization_id: ORG, case_id: caseId }), {
    ok: true,
    value: { task: "", organizationId: ORG, files: [], caseId, model: null },
  });
  // Another writer model for this run only (SYS-33), as provider:model.
  const withModel = parseNewRun({ task: "", organization_id: ORG, case_id: caseId, model: " anthropic:claude-sonnet-5-5 " });
  assert.ok(withModel.ok && withModel.value.model === "anthropic:claude-sonnet-5-5");
  assert.equal(parseNewRun({ task: "", organization_id: ORG, case_id: caseId, model: "sonnet" }).ok, false);
  assert.equal(parseNewRun({ task: "", organization_id: ORG, case_id: caseId, model: 5 }).ok, false);
  assert.equal(parseNewRun({ task: "x", organization_id: ORG, case_id: "rear-lamp" }).ok, false);
  // Files go to the case first; a run that named both would read only one of them.
  assert.equal(parseNewRun({ task: "x", organization_id: ORG, case_id: caseId, files: [FILE] }).ok, false);
});
