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

test("parseNewRun trims the task and enforces the database limits", () => {
  assert.deepEqual(parseNewRun({ task: "  Triage ECN-1001  " }), {
    ok: true,
    value: { task: "Triage ECN-1001" },
  });
  assert.equal(parseNewRun({ task: "   " }).ok, false);
  assert.equal(parseNewRun({ task: 5 }).ok, false);
  assert.equal(parseNewRun(null).ok, false);
  assert.equal(parseNewRun(["task"]).ok, false);
  assert.equal(parseNewRun({ task: "x".repeat(TASK_MAX_LENGTH) }).ok, true);
  assert.equal(parseNewRun({ task: "x".repeat(TASK_MAX_LENGTH + 1) }).ok, false);
});

test("parseNewRun counts characters, not UTF-16 units, as Postgres does", () => {
  const astral = "\u{1F527}";
  assert.equal(astral.length, 2);
  assert.equal(parseNewRun({ task: astral.repeat(TASK_MAX_LENGTH) }).ok, true);
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
